import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify } from "yaml";

import type { ImportedVlessRevision } from "./subscription.js";

type MihomoConfig = ImportedVlessRevision["mihomoConfig"];

export interface MihomoStaticCheckOptions {
  binary?: string;
  run?: (binary: string, arguments_: readonly string[]) => Promise<void>;
}

export interface ManagedMihomoRuntimeOptions {
  binary?: string;
  directory: string;
}

interface ManagedProcess {
  child: ChildProcess | undefined;
  configPath: string;
  fingerprint: string;
  listener: URL;
}

export class ManagedMihomoRuntime {
  readonly #binary: string;
  readonly #directory: string;
  readonly #exitListeners = new Set<() => void>();
  readonly #expectedExits = new WeakSet<ChildProcess>();
  readonly #failedProcesses = new Set<ManagedProcess>();
  readonly #processes = new Map<string, ManagedProcess>();
  #closed = false;
  #lastApplied = new Set<ManagedProcess>();

  constructor(options: ManagedMihomoRuntimeOptions) {
    this.#binary = options.binary ?? "mihomo";
    this.#directory = options.directory;
  }

  check(config: MihomoConfig): Promise<void> {
    return checkMihomoConfig(config, { binary: this.#binary });
  }

  async apply(
    config: MihomoConfig,
    context: { preserveListeners: readonly URL[] },
  ): Promise<ReadonlyMap<string, URL>> {
    if (this.#closed) {
      throw new Error("managed Mihomo runtime is closed");
    }
    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    const started: ManagedProcess[] = [];
    const next = new Set<ManagedProcess>();
    const listeners = new Map<string, URL>();
    try {
      for (const listenerConfig of config.listeners) {
        const proxy = config.proxies.find(({ name }) => name === listenerConfig.proxy);
        if (!proxy) {
          throw new Error(`Mihomo listener has no proxy: ${listenerConfig.proxy}`);
        }
        const listener = new URL(`http://${listenerConfig.listen}:${listenerConfig.port}`);
        const processConfig: MihomoConfig = { listeners: [listenerConfig], proxies: [proxy] };
        const fingerprint = configFingerprint(processConfig);
        const existing = this.#processes.get(listener.href);
        if (existing && existing.fingerprint !== fingerprint) {
          throw new Error(`Mihomo listener configuration changed without a new port: ${listener}`);
        }
        if (existing && (!existing.child || existing.child.exitCode !== null)) {
          await this.#start(existing, new AbortController().signal);
          this.#failedProcesses.delete(existing);
        }
        const managed =
          existing ?? (await this.#createProcess(processConfig, fingerprint, listener));
        if (!existing) {
          started.push(managed);
        }
        next.add(managed);
        listeners.set(listenerConfig.proxy, listener);
      }
    } catch (error) {
      await Promise.allSettled(started.map((managed) => this.#removeProcess(managed)));
      throw error;
    }
    const preserved = new Set(context.preserveListeners.map(({ href }) => href));
    const uncommitted = [...this.#lastApplied].filter(
      (managed) => !next.has(managed) && !preserved.has(managed.listener.href),
    );
    await Promise.allSettled(uncommitted.map((managed) => this.#removeProcess(managed)));
    this.#lastApplied = next;
    return listeners;
  }

  onUnexpectedExit(listener: () => void): () => void {
    this.#exitListeners.add(listener);
    queueMicrotask(() => {
      if (!this.#closed && this.#failedProcesses.size > 0 && this.#exitListeners.has(listener)) {
        listener();
      }
    });
    return () => this.#exitListeners.delete(listener);
  }

  async removeListener(listener: URL): Promise<void> {
    const managed = this.#processes.get(listener.href);
    if (!managed) {
      return;
    }
    await this.#removeProcess(managed);
    this.#lastApplied.delete(managed);
  }

  async restart(signal: AbortSignal): Promise<void> {
    const failed = [...this.#failedProcesses];
    if (failed.length === 0) {
      return;
    }
    for (const managed of failed) {
      await this.#start(managed, signal);
      this.#failedProcesses.delete(managed);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#processes.values()].map((managed) => this.#stop(managed)));
    this.#processes.clear();
    this.#failedProcesses.clear();
    this.#lastApplied.clear();
  }

  async #createProcess(
    config: MihomoConfig,
    fingerprint: string,
    listener: URL,
  ): Promise<ManagedProcess> {
    const configPath = join(this.#directory, `${fingerprint}.yaml`);
    await writeFile(configPath, stringify(config), { encoding: "utf8", mode: 0o600 });
    const managed: ManagedProcess = {
      child: undefined,
      configPath,
      fingerprint,
      listener,
    };
    this.#processes.set(listener.href, managed);
    try {
      await this.#start(managed, new AbortController().signal);
      return managed;
    } catch (error) {
      this.#processes.delete(listener.href);
      throw error;
    }
  }

  async #removeProcess(managed: ManagedProcess): Promise<void> {
    await this.#stop(managed);
    this.#failedProcesses.delete(managed);
    if (this.#processes.get(managed.listener.href) === managed) {
      this.#processes.delete(managed.listener.href);
    }
  }

  async #start(managed: ManagedProcess, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason;
    }
    const child = spawn(this.#binary, ["-d", this.#directory, "-f", managed.configPath], {
      stdio: "ignore",
    });
    managed.child = child;
    child.once("exit", () => {
      if (managed.child === child) {
        managed.child = undefined;
      }
      if (!this.#expectedExits.has(child) && !this.#closed) {
        this.#failedProcesses.add(managed);
        for (const listener of this.#exitListeners) {
          listener();
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.#expectedExits.add(child);
        child.kill("SIGTERM");
        reject(signal.reason);
      };
      const onError = (error: Error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #stop(managed: ManagedProcess): Promise<void> {
    const child = managed.child;
    if (!child || child.exitCode !== null) {
      return;
    }
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
