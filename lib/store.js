/**
 * 落盘状态：账号凭据 + 学习结果（车道、模型目录缓存）。
 *
 * 相对原版的两点改动：
 * 1. 按 mtime 热重载——手工改 account.json 不必重启 DSH；
 * 2. 原子写 + 0600 权限——写一半断电不会留下坏凭据。
 */

import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const ACCOUNT_FILE = "account.json";
const STATE_FILE = "state.json";
const DATA_DIR_NAME = ".dsh-deepai-freemodel";
const LEGACY_DATA_DIR_NAME = ".dsh-deepai-connect";

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch {
    // 坏文件当不存在处理，下一次写入会覆盖
    return { exists: false, corrupt: true };
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await chmod(tmp, 0o600);
    } catch {
      /* Windows 上无意义，忽略 */
    }
    await rename(tmp, path);
  } catch (error) {
    // 写入或改名失败时别把临时文件留在用户目录里
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export class PluginStore {
  #dir;
  #account;
  #state;
  /** 写入串行化：车道与模型目录会并发 patchState，浅合并下会互相覆盖。 */
  #writeQueue = Promise.resolve();

  constructor(dir) {
    this.#dir = dir;
  }

  /** 把一次落盘排进队列，保证「读当前值 → 合并 → 写入」不被打断。 */
  #enqueue(task) {
    const run = this.#writeQueue.then(task, task);
    this.#writeQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  get dir() {
    return this.#dir;
  }

  get accountPath() {
    return join(this.#dir, ACCOUNT_FILE);
  }

  get statePath() {
    return join(this.#dir, STATE_FILE);
  }

  async #ensureDir() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
  }

  /** 账号。文件变了就重读，返回 null 表示未登录。 */
  async account() {
    const cached = this.#account;
    if (cached !== undefined) {
      try {
        const info = await stat(this.accountPath);
        if (info.mtimeMs === cached.mtimeMs) return cached.value;
      } catch (error) {
        if (error?.code === "ENOENT") {
          this.#account = undefined;
          return null;
        }
        return cached.value;
      }
    }
    const { exists, value } = await readJson(this.accountPath);
    if (!exists || typeof value !== "object" || value === null) {
      this.#account = undefined;
      return null;
    }
    const account = {
      apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
      username: typeof value.username === "string" ? value.username : "",
      isPro: value.isPro === true,
      obtainedAt: typeof value.obtainedAt === "string" ? value.obtainedAt : ""
    };
    if (account.apiKey === "") {
      this.#account = undefined;
      return null;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(this.accountPath)).mtimeMs;
    } catch {
      /* 刚被删，按内存值返回 */
    }
    this.#account = { mtimeMs, value: account };
    return account;
  }

  async setAccount(account) {
    return this.#enqueue(async () => {
      await this.#ensureDir();
      const payload = {
        apiKey: account.apiKey,
        username: account.username ?? "",
        isPro: account.isPro === true,
        obtainedAt: account.obtainedAt ?? new Date().toISOString().replace("T", " ").slice(0, 19)
      };
      await writeJsonAtomic(this.accountPath, payload);
      try {
        this.#account = { mtimeMs: (await stat(this.accountPath)).mtimeMs, value: payload };
      } catch {
        this.#account = undefined;
      }
      return payload;
    });
  }

  async clearAccount() {
    return this.#enqueue(async () => {
      this.#account = undefined;
      try {
        await rm(this.accountPath, { force: true });
      } catch {
        /* 本来就没有 */
      }
    });
  }

  /** 学习结果：车道、模型目录缓存。 */
  async state() {
    const cached = this.#state;
    if (cached !== undefined) {
      try {
        const info = await stat(this.statePath);
        if (info.mtimeMs === cached.mtimeMs) return cached.value;
      } catch (error) {
        if (error?.code === "ENOENT") {
          this.#state = undefined;
          return {};
        }
        return cached.value;
      }
    }
    const { exists, value } = await readJson(this.statePath);
    const state = exists && typeof value === "object" && value !== null ? value : {};
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(this.statePath)).mtimeMs;
    } catch {
      /* 未落盘 */
    }
    this.#state = { mtimeMs, value: state };
    return state;
  }

  async patchState(patch) {
    return this.#enqueue(async () => {
      const current = await this.state();
      const next = { ...current, ...patch };
      await this.#ensureDir();
      await writeJsonAtomic(this.statePath, next);
      try {
        this.#state = { mtimeMs: (await stat(this.statePath)).mtimeMs, value: next };
      } catch {
        this.#state = undefined;
      }
      return next;
    });
  }
}

export function defaultDataDir(env = process.env) {
  const override = (env.DEEPAI_DATA_DIR ?? "").trim();
  if (override !== "") return override;
  return join(homedir(), DATA_DIR_NAME);
}

/** 改名前的目录，只在一次迁移里读。 */
export function legacyDataDir() {
  return join(homedir(), LEGACY_DATA_DIR_NAME);
}

/**
 * 从旧目录接管凭据。
 *
 * 插件改过名，老用户的 account.json 还在 `~/.dsh-deepai-connect`。
 * 只搬这两个已知文件，并且新目录已有凭据时什么都不做——
 * 宁可多一次判断，也不要覆盖用户刚登录的 Key。
 *
 * @returns {Promise<boolean>} 是否真的搬了
 */
export async function adoptLegacyData(dir, legacy = legacyDataDir()) {
  if (dir === legacy) return false;
  try {
    await stat(join(dir, ACCOUNT_FILE));
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }
  try {
    await stat(join(legacy, ACCOUNT_FILE));
  } catch {
    return false;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let moved = 0;
  for (const file of [ACCOUNT_FILE, STATE_FILE]) {
    try {
      await copyFile(join(legacy, file), join(dir, file));
      moved += 1;
    } catch {
      /* 单个文件缺失不影响另一个 */
    }
  }
  return moved > 0;
}
