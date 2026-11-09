#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { open, mkdir, readFile, rename, rm, chmod, copyFile, constants, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const SITE_ORIGIN = 'https://v8api.wiki';
export const DEVICE_URL = `${SITE_ORIGIN}/api/agent-skill/device`;
export const POLL_URL = `${SITE_ORIGIN}/api/agent-skill/device/poll`;
export const SKILL_NAME = 'v8-api';

export function validateUserId(userId) {
  if (typeof userId !== 'string' || !/^\d{1,15}$/.test(userId)) {
    throw new Error('用户 ID 格式无效');
  }
  const numericId = Number(userId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error('用户 ID 格式无效');
  return numericId;
}

export function getCredentialDirectory({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'v8-api-agent-skill', 'credentials');
  }
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'v8-api-agent-skill', 'credentials');
}

function unwrapData(payload) {
  if (!payload || payload.success !== true || !payload.data || typeof payload.data !== 'object') {
    throw new Error('授权服务返回了无效响应');
  }
  return payload.data;
}

async function postJson(fetchImpl, endpoint, body) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接 V8 API 授权服务');
  }
  if (!response.ok) throw new Error(`授权服务请求失败（HTTP ${response.status}）`);
  try {
    return unwrapData(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === '授权服务返回了无效响应') throw error;
    throw new Error('授权服务返回了无效响应');
  }
}

export async function startDeviceAuthorization(userId, fetchImpl = fetch) {
  const data = await postJson(fetchImpl, DEVICE_URL, { user_id: validateUserId(userId) });
  let verificationUri;
  try {
    verificationUri = new URL(data.verification_uri);
  } catch {
    throw new Error('授权服务返回了无效的验证地址');
  }
  if (verificationUri.protocol !== 'https:' || verificationUri.origin !== SITE_ORIGIN) {
    throw new Error('授权服务返回了无效的验证地址');
  }
  if (typeof data.device_code !== 'string' || data.device_code.length < 1 || data.device_code.length > 128) {
    throw new Error('授权服务返回了无效响应');
  }
  if (typeof data.user_code !== 'string' || !/^[\x20-\x7e]{1,32}$/.test(data.user_code)) {
    throw new Error('授权服务返回了无效响应');
  }
  if (!Number.isFinite(data.expires_in) || data.expires_in <= 0 || !Number.isFinite(data.interval) || data.interval <= 0) {
    throw new Error('授权服务返回了无效响应');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: verificationUri.href,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

export async function pollDeviceAuthorization(deviceCode, fetchImpl = fetch) {
  const data = await postJson(fetchImpl, POLL_URL, { device_code: deviceCode });
  const status = data.status;
  if (status === 'authorization_pending' || status === 'slow_down') {
    return { status, interval: data.interval };
  }
  if (status === 'access_denied' || status === 'expired_token') {
    return { status };
  }
  if (status !== 'authorized' || !data.credential || typeof data.credential !== 'object' ||
      typeof data.credential.name !== 'string' || typeof data.credential.api_key !== 'string') {
    throw new Error('授权服务返回了无效响应');
  }
  const name = data.credential.name.trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) || !data.credential.api_key) {
    throw new Error('授权服务返回了无效响应');
  }
  return { status: 'authorized', name, key: data.credential.api_key };
}

export async function waitForDeviceApproval(device, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + device.expiresIn * 1000;
  let interval = Math.max(1, Math.ceil(device.interval));
  while (now() < deadline) {
    await sleep(Math.min(interval * 1000, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const result = await pollDeviceAuthorization(device.deviceCode, fetchImpl);
    if (result.status === 'authorized') return result;
    if (result.status === 'access_denied') throw new Error('用户拒绝了本次授权');
    if (result.status === 'expired_token') throw new Error('授权已过期，请重新运行命令');
    if (result.status === 'slow_down') interval += 1;
    if (result.status === 'authorization_pending' && Number.isFinite(result.interval) && result.interval > interval) {
      interval = Math.ceil(result.interval);
    }
  }
  throw new Error('等待授权超时，请重新运行命令');
}

function credentialNameHash(name) {
  return createHash('sha256').update(name, 'utf8').digest('hex');
}

function validateCredential(entry, filename) {
  if (!entry || entry.version !== 1 || typeof entry.name !== 'string' || typeof entry.key !== 'string' || !entry.key ||
      !entry.name.trim() || entry.name.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.name) ||
      filename !== `${credentialNameHash(entry.name.trim())}.json`) {
    throw new Error('本机凭据文件格式无效');
  }
  return { name: entry.name.trim(), key: entry.key };
}

export async function readCredentialStore(directoryPath) {
  let files;
  try {
    files = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, credentials: [] };
    throw error;
  }
  const credentials = [];
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
    try {
      credentials.push(validateCredential(JSON.parse(await readFile(path.join(directoryPath, file.name), 'utf8')), file.name));
    } catch {
      throw new Error('本机凭据文件格式无效');
    }
  }
  return { version: 1, credentials };
}

export async function saveCredential(filePath, credential) {
  const name = typeof credential?.name === 'string' ? credential.name.trim() : '';
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) || typeof credential.key !== 'string' || !credential.key) {
    throw new Error('密钥信息无效，未作保存');
  }
  await mkdir(filePath, { recursive: true, mode: 0o700 });
  const destination = path.join(filePath, `${credentialNameHash(name)}.json`);
  const temporaryPath = path.join(filePath, `.credential-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ version: 1, name, key: credential.key }, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destination);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true });
    throw new Error('无法安全保存本机凭据文件');
  }
  return { name };
}

async function skillSourcePath() {
  return fileURLToPath(new URL('../skill', import.meta.url));
}

async function preflightSkillInstall(targetDirectory, sourceDirectory) {
  for (const relativePath of ['SKILL.md', path.join('scripts', 'v8-api.mjs')]) {
    let current;
    try {
      current = await readFile(path.join(targetDirectory, relativePath));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      continue;
    }
    const source = await readFile(path.join(sourceDirectory, relativePath));
    if (!current.equals(source)) throw new Error('目标工作区已存在不同版本的 V8 API Skill；未覆盖现有文件');
  }
}

export async function installSkill(targetDirectory, sourceDirectory) {
  const source = sourceDirectory || await skillSourcePath();
  await preflightSkillInstall(targetDirectory, source);
  await mkdir(path.join(targetDirectory, 'scripts'), { recursive: true });
  for (const relativePath of ['SKILL.md', path.join('scripts', 'v8-api.mjs')]) {
    const destination = path.join(targetDirectory, relativePath);
    try {
      await readFile(destination);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await copyFile(path.join(source, relativePath), destination, constants.COPYFILE_EXCL);
    }
  }
}

async function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('Usage: npx -y --package https://v8api.wiki/skills/v8-api-agent-skill.tgz v8-api-agent-skill <USER_ID>\n');
    return;
  }
  if (args.length !== 1) throw new Error('请提供网站账户的用户 ID');
  const userId = validateUserId(args[0]);
  const workspaceSkillPath = path.join(process.cwd(), '.agents', 'skills', SKILL_NAME);
  const sourceDirectory = await skillSourcePath();
  await preflightSkillInstall(workspaceSkillPath, sourceDirectory);
  await installSkill(workspaceSkillPath, sourceDirectory);
  process.stdout.write(`Skill 已安装到 ${workspaceSkillPath}\n`);
  const filePath = getCredentialPath();
  const device = await startDeviceAuthorization(userId);
  process.stdout.write(`请打开 ${device.verificationUri}\n并输入用户码：${device.userCode}\n`);
  process.stdout.write('登录 V8 API 后确认并选择要绑定的密钥。\n');
  const authorized = await waitForDeviceApproval(device);
  const saved = await saveCredential(filePath, authorized);
  process.stdout.write(`已保存密钥：${JSON.stringify(saved.name)}\n`);
}

if (process.argv[1]) {
  try {
    const ownPath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(path.resolve(process.argv[1]));
    const samePath = process.platform === 'win32'
      ? ownPath.toLowerCase() === invokedPath.toLowerCase()
      : ownPath === invokedPath;
    if (samePath) {
      main(process.argv.slice(2)).catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : '执行失败'}\n`);
        process.exitCode = 1;
      });
    }
  } catch {
    process.exitCode = 1;
  }
}
