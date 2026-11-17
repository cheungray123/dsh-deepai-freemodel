/**
 * 机器指纹：桌面端把 sha256(机器唯一标识) 放在 `X-DeepAI-Code-Machine` 头里。
 * 拿不到就退化成「不带这个头」，不影响鉴权，只是少了设备识别。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PLACEHOLDER_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
  "00020003-0004-0005-0006-000700080009"
]);

function fingerprintOf(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "") return "";
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlaceholder(raw) {
  return PLACEHOLDER_UUIDS.has(String(raw).trim().toLowerCase());
}

async function windowsRaw() {
  // 优先 CIM；PowerShell 冷启动慢，失败再用 reg（毫秒级）
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"],
      { timeout: 8_000, windowsHide: true }
    );
    const uuid = stdout.trim();
    if (uuid !== "" && !isPlaceholder(uuid)) return uuid;
  } catch {
    /* 继续下一种方式 */
  }
  try {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { timeout: 8_000, windowsHide: true }
    );
    const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout);
    if (match?.[1] !== undefined) return match[1].trim();
  } catch {
    /* 拿不到就算了 */
  }
  return "";
}

async function darwinRaw() {
  try {
    const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 8_000 });
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

async function linuxRaw() {
  for (const path of ["/sys/class/dmi/id/product_uuid", "/etc/machine-id"]) {
    try {
      const raw = (await readFile(path, "utf8")).trim();
      if (raw !== "" && !isPlaceholder(raw)) return raw;
    } catch {
      /* 试下一个 */
    }
  }
  return "";
}

let cached;

/**
 * 探测指纹。进程内只探一次；探测本身慢（要拉 PowerShell），
 * 所以调用方应当不 await 它，拿到结果再补头。
 */
export function detectMachineFingerprint() {
  if (cached !== undefined) return cached;
  cached = (async () => {
    const override = (process.env.DEEPAI_MACHINE_ID ?? "").trim();
    if (override !== "") return fingerprintOf(override);
    let raw = "";
    if (process.platform === "win32") raw = await windowsRaw();
    else if (process.platform === "darwin") raw = await darwinRaw();
    else raw = await linuxRaw();
    return fingerprintOf(raw);
  })();
  return cached;
}

export function machineFingerprintOf(raw) {
  return fingerprintOf(raw);
}
