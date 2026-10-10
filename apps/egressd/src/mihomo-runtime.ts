import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { stringify } from "yaml";

import type { ImportedVlessRevision } from "./subscription.js";

type MihomoConfig = ImportedVlessRevision["mihomoConfig"];
type RuntimeListener = { config: MihomoConfig; fingerprint: string };

export interface MihomoStaticCheckOptions {
  binary?: string;
  run?: (binary: string, arguments_: readonly string[]) => Promise<void>;
}

export interface ManagedMihomoRuntimeOptions {
  binary?: string;
  directory: string;
}

/** One serving process; immutable per-generation listeners avoid shared-select races. */
export class ManagedMihomoRuntime {
  readonly #binary: string;
  readonly #directory: string;
  readonly #exitListeners = new Set<() => void>();
  readonly #expectedExits = new WeakSet<ChildProcess>();
  readonly #secret = randomBytes(32).toString("hex");
  #listeners = new Map<string, RuntimeListener>();
  #child: ChildProcess | undefined;
  #controllerDirectory: string | undefined;
  #closed = false;
  #failed = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ManagedMihomoRuntimeOptions) {
    this.#binary = options.binary ?? "mihomo";
    this.#directory = options.directory;
  }

  check(config: MihomoConfig): Promise<void> {
    return checkMihomoConfig(config, { binary: this.#binary });
  }

  apply(
    config: MihomoConfig,
    context: { preserveListeners: readonly URL[] },
  ): Promise<ReadonlyMap<string, URL>> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const next = new Map<string, RuntimeListener>();
      for (const listener of context.preserveListeners) {
        const existing = this.#listeners.get(listener.href);
        if (existing) next.set(listener.href, existing);
      }
      const result = new Map<string, URL>();
      for (const listener of config.listeners) {
        const proxy = config.proxies.find(({ name }) => name === listener.proxy);
        if (!proxy) throw new Error("Mihomo listener has no proxy");
        const url = new URL(`http://${listener.listen}:${listener.port}`);
        const original = { listeners: [listener], proxies: [proxy] };
        const fingerprint = configFingerprint(original);
        const existing = this.#listeners.get(url.href);
        if (existing && existing.fingerprint !== fingerprint) {
          throw new Error("Mihomo listener configuration changed without a new port");
        }
        // Old and new generations may have the same logical name. Name by immutable port.
        const name = `egresskit-${listener.port}`;
        next.set(url.href, {
          config: {
            listeners: [{ ...listener, name, proxy: name }],
            proxies: [{ ...proxy, name }],
          },
          fingerprint,
        });
        result.set(listener.proxy, url);
      }
      await this.#install(next);
      return result;
    });
  }

  onUnexpectedExit(listener: () => void): () => void {
    this.#exitListeners.add(listener);
    queueMicrotask(() => {
      if (!this.#closed && this.#failed && this.#exitListeners.has(listener)) listener();
    });
    return () => this.#exitListeners.delete(listener);
  }

  removeListener(listener: URL): Promise<void> {
    return this.#serialize(async () => {
      this.#assertOpen();
      if (!this.#listeners.has(listener.href)) return;
      const next = new Map(this.#listeners);
      next.delete(listener.href);
      await this.#install(next);
    });
  }

  restart(signal: AbortSignal): Promise<void> {
    return this.#serialize(async () => {
      this.#assertOpen();
      if (!this.#failed) return;
      await this.#start(signal);
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#serialize(async () => {
      await this.#stop();
      this.#listeners.clear();
      if (this.#controllerDirectory)
        await rm(this.#controllerDirectory, { recursive: true, force: true });
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("managed Mihomo runtime is closed");
  }

  #payload(listeners: ReadonlyMap<string, RuntimeListener>): string {
    return stringify({
      listeners: [...listeners.values()].flatMap(({ config }) => config.listeners),
      proxies: [...listeners.values()].flatMap(({ config }) => config.proxies),
      "external-controller-unix": join(this.#controllerDirectory as string, "controller.sock"),
      secret: this.#secret,
      "log-level": "silent",
    });
  }

  async #writeConfig(payload: string): Promise<void> {
    const temporary = join(this.#directory, "runtime.next.yaml");
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, join(this.#directory, "runtime.yaml"));
  }

  async #install(next: Map<string, RuntimeListener>): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    // Keep the Unix socket path short even when the configured state path is long.
    this.#controllerDirectory ??= await mkdtemp(join(tmpdir(), "egresskit-ctl-"));
    const payload = this.#payload(next);
    const previous = this.#payload(this.#listeners);
    if (!this.#child) {
      await this.#writeConfig(payload);
      try {
        await this.#start(new AbortController().signal);
      } catch (error) {
        await this.#writeConfig(previous);
        throw error;
      }
    } else if (payload !== previous) {
      try {
        await this.#control("PUT", "/configs?force=false", JSON.stringify({ payload }));
        await this.#writeConfig(payload);
      } catch (error) {
        // Reload may partially succeed (e.g. a listener cannot bind). Restore the old set.
        try {
          await this.#control("PUT", "/configs?force=false", JSON.stringify({ payload: previous }));
          await this.#writeConfig(previous);
        } catch {
          await this.#stop();
          this.#failed = true;
          for (const listener of this.#exitListeners) listener();
        }
        throw error;
      }
    }
    this.#listeners = next;
  }

  #control(method: string, path: string, body?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const operation = request(
        {
          socketPath: join(this.#controllerDirectory as string, "controller.sock"),
          method,
          path,
          headers: { authorization: `Bearer ${this.#secret}`, "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          response.once("error", reject);
          response.once("end", () => {
            if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
              resolve();
            else reject(new Error("Mihomo controller rejected runtime configuration"));
          });
        },
      );
      operation.setTimeout(5_000, () =>
        operation.destroy(new Error("Mihomo controller timed out")),
      );
      operation.once("error", reject);
      operation.end(body);
    });
  }

  async #start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const socketPath = join(this.#controllerDirectory as string, "controller.sock");
    await rm(socketPath, { force: true });
    const child = spawn(
      this.#binary,
      ["-d", this.#directory, "-f", join(this.#directory, "runtime.yaml")],
      { stdio: "ignore" },
    );
    this.#child = child;
    child.on("error", () => undefined);
    child.once("exit", () => {
      if (this.#child === child) this.#child = undefined;
      if (!this.#expectedExits.has(child) && !this.#closed) {
        this.#failed = true;
        for (const listener of this.#exitListeners) listener();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      const deadline = Date.now() + 5_000;
      while (true) {
        signal.throwIfAborted();
        if (this.#child !== child) throw new Error("Mihomo exited before controller readiness");
        try {
          await this.#control("GET", "/version");
          break;
        } catch {
          if (Date.now() >= deadline) throw new Error("Mihomo controller readiness timed out");
          await delay(25, undefined, { signal });
        }
      }
      await chmod(socketPath, 0o600);
      this.#failed = false;
    } catch (error) {
      await this.#stop();
      throw error;
    }
  }

  async #stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#expectedExits.add(child);
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      if (!child.kill("SIGTERM")) {
        clearTimeout(force);
        resolve();
      }
    });
    if (this.#child === child) this.#child = undefined;
  }
}

export async function checkMihomoConfig(
  config: MihomoConfig,
  options: MihomoStaticCheckOptions = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "egresskit-mihomo-check-"));
  const candidatePath = join(directory, "candidate.yaml");
  try {
    await writeFile(candidatePath, stringify(config), { encoding: "utf8", mode: 0o600 });
    await (options.run ?? runMihomo)(options.binary ?? "mihomo", ["-t", "-f", candidatePath]);
  } catch (error) {
    throw new Error("official Mihomo static check failed", { cause: error });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function runMihomo(binary: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Mihomo static check exited with ${signal ?? code ?? "unknown status"}`));
    });
  });
}

function configFingerprint(config: MihomoConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
