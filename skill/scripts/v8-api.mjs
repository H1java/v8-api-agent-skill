#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://api.v8.wiki';

export function credentialDirectory({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const base = platform === 'win32'
    ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'v8-api-agent-skill', 'credentials');
}

export function allowedRoute(method, route) {
  if (method === 'GET' && route === '/v1/models') return true;
  if (method === 'POST' && [
    '/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/images/generations',
    '/v1/embeddings', '/v1/rerank', '/v1/alpha/search', '/v1/tools/search',
    '/v1/tools/fetch', '/v1/video/generations',
  ].includes(route)) return true;
  if (method === 'GET' && /^\/v1\/video\/generations\/[A-Za-z0-9_-]+$/.test(route)) return true;
  if (method === 'POST' && /^\/v1beta\/models\/[A-Za-z0-9._-]+:generateContent$/.test(route)) return true;
  return false;
}

export async function loadCredentials(filePath) {
  let files;
  try {
    files = await readdir(filePath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('尚未绑定 V8 API 密钥；请先运行门户提供的安装命令');
    throw new Error('无法读取本机凭据文件');
  }
  const credentials = [];
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
    let entry;
    try {
      entry = JSON.parse(await readFile(path.join(filePath, file.name), 'utf8'));
    } catch {
      throw new Error('本机凭据文件格式无效');
    }
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const expectedFile = `${createHash('sha256').update(name, 'utf8').digest('hex')}.json`;
    if (entry?.version !== 1 || !name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name) ||
        typeof entry.key !== 'string' || !entry.key || file.name !== expectedFile) {
      throw new Error('本机凭据文件格式无效');
    }
    credentials.push({ name, key: entry.key });
  }
  if (credentials.length === 0) throw new Error('尚未绑定 V8 API 密钥；请先运行门户提供的安装命令');
  return credentials;
}

export function selectCredential(credentials, name) {
  const selected = credentials.find(entry => entry.name === name);
  if (!selected) throw new Error('找不到所选密钥名称；请先查看本机密钥名称列表');
  return selected;
}

export function redact(text, secret) {
  return typeof secret === 'string' && secret ? text.split(secret).join('[redacted]') : text;
}

export async function sendRequest({ method, route, body, key, fetchImpl = fetch }) {
  if (!allowedRoute(method, route)) throw new Error('该 API 路径或 HTTP 方法不在支持范围内');
  if (method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body))) {
    throw new Error('POST 请求需要 JSON 对象作为请求体');
  }
  const url = new URL(route, API_ORIGIN);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error('V8 API 请求失败；未输出服务器错误正文');
  }
  if (!response.ok) throw new Error(`V8 API 请求失败（HTTP ${response.status}）；未输出服务器错误正文`);
  const text = await response.text();
  return redact(text, key);
}

function parseArgs(args) {
  const result = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith('--')) {
      const name = value.slice(2);
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`缺少参数值：${value}`);
      result[name] = args[++index];
    } else result._.push(value);
  }
  return result;
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    throw new Error('标准输入必须是有效 JSON');
  }
}

async function run(args) {
  const parsed = parseArgs(args);
  const command = parsed._[0];
  const credentials = await loadCredentials(credentialDirectory());
  if (command === 'keys') {
    process.stdout.write(`${JSON.stringify(credentials.map(({ name }, index) => ({ index: index + 1, name })), null, 2)}\n`);
    return;
  }
  if (!['models', 'call'].includes(command)) throw new Error('用法：keys | models --key-name <名称> | call --key-name <名称> --method <方法> --path <路径>');
  const selected = selectCredential(credentials, parsed['key-name']);
  if (command === 'models') {
    const output = await sendRequest({ method: 'GET', route: '/v1/models', key: selected.key });
    let payload;
    try {
      payload = JSON.parse(output);
    } catch {
      throw new Error('模型目录响应格式无效');
    }
    if (!Array.isArray(payload.data)) throw new Error('模型目录响应格式无效');
    process.stdout.write(`${JSON.stringify(payload.data.map(model => ({ id: model.id, supported_endpoint_types: model.supported_endpoint_types })), null, 2)}\n`);
    return;
  }
  const method = parsed.method?.toUpperCase();
  if (!['GET', 'POST'].includes(method) || !parsed.path) throw new Error('call 需要 --method GET|POST 和 --path');
  const body = method === 'POST' ? await readStdin() : undefined;
  const output = await sendRequest({ method, route: parsed.path, body, key: selected.key });
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : '执行失败'}\n`);
    process.exitCode = 1;
  });
}
