import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVICE_URL,
  POLL_URL,
  getCredentialDirectory,
  installSkill,
  pollDeviceAuthorization,
  readCredentialStore,
  saveCredential,
  startDeviceAuthorization,
  validateUserId,
  waitForDeviceApproval,
} from '../bin/cli.mjs';
import { allowedRoute, loadCredentials, redact, sendRequest, selectCredential } from '../skill/scripts/v8-api.mjs';

const tempDirectories = new Set();

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'v8-api-agent-skill-'));
  tempDirectories.add(directory);
  return directory;
}

test.after(async () => {
  await Promise.all([...tempDirectories].map(directory => rm(directory, { recursive: true, force: true })));
});

function apiResponse(data, success = true) {
  return new Response(JSON.stringify({ success, data }), { status: success ? 200 : 400 });
}

test('validates user IDs before contacting the service', () => {
  assert.equal(validateUserId('42'), 42);
  for (const userId of ['', '0', '../other', 'acct_123', '1;whoami', 'has space', '9'.repeat(16)]) {
    assert.throws(() => validateUserId(userId), /用户 ID 格式无效/);
  }
});

test('starts device authorization with only the account ID and validates the verification origin', async () => {
  let request;
  const device = await startDeviceAuthorization('42', async (url, options) => {
    request = { url, options };
    return apiResponse({
      device_code: 'private-device-code',
      user_code: 'ABCD-1234',
      verification_uri: 'https://v8api.wiki/#/device?code=ABCD-1234',
      expires_in: 600,
      interval: 3,
    });
  });
  assert.equal(request.url, DEVICE_URL);
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { user_id: 42 });
  assert.deepEqual(device, {
    deviceCode: 'private-device-code',
    userCode: 'ABCD-1234',
    verificationUri: 'https://v8api.wiki/#/device?code=ABCD-1234',
    expiresIn: 600,
    interval: 3,
  });
  await assert.rejects(startDeviceAuthorization('42', async () => apiResponse({
    device_code: 'private-device-code', user_code: 'ABCD', verification_uri: 'https://attacker.example/claim', expires_in: 60, interval: 3,
  })), /无效的验证地址/);
  await assert.rejects(startDeviceAuthorization('42', async () => apiResponse({
    device_code: 'private-device-code', user_code: 'ABCD\u001b[31m', verification_uri: 'https://v8api.wiki/#/device', expires_in: 60, interval: 3,
  })), /无效响应/);
});

test('polls with the private device code and returns the authorized named key only to the caller', async () => {
  let request;
  const approved = await pollDeviceAuthorization('private-device-code', async (url, options) => {
    request = { url, options };
    return apiResponse({ status: 'authorized', credential: { name: 'Production', api_key: 'secret-key-value' } });
  });
  assert.equal(request.url, POLL_URL);
  assert.deepEqual(JSON.parse(request.options.body), { device_code: 'private-device-code' });
  assert.deepEqual(approved, { status: 'authorized', name: 'Production', key: 'secret-key-value' });
});

test('honors the polling interval returned by the authorization service', async () => {
  let time = 0;
  const sleeps = [];
  let polls = 0;
  const approved = await waitForDeviceApproval(
    { deviceCode: 'private-device-code', expiresIn: 30, interval: 2 },
    {
      now: () => time,
      sleep: async ms => { sleeps.push(ms); time += ms; },
      fetchImpl: async () => {
        polls += 1;
        return apiResponse(polls === 1
          ? { status: 'authorization_pending', interval: 4 }
          : { status: 'authorized', credential: { name: 'Personal', api_key: 'another-secret' } });
      },
    },
  );
  assert.deepEqual(sleeps, [2000, 4000]);
  assert.equal(approved.name, 'Personal');
});

test('stores multiple keys by name, replaces a repeated name, and applies private file mode', async () => {
  const directory = await temporaryDirectory();
  const credentialDirectory = path.join(directory, 'config', 'credentials');
  await saveCredential(credentialDirectory, { name: 'Production', key: 'secret-one' });
  await saveCredential(credentialDirectory, { name: 'Personal', key: 'secret-two' });
  const result = await saveCredential(credentialDirectory, { name: 'Production', key: 'secret-one-rotated' });
  const store = await readCredentialStore(credentialDirectory);
  assert.deepEqual(result, { name: 'Production' });
  assert.deepEqual(store.credentials.sort((left, right) => left.name.localeCompare(right.name)), [
    { name: 'Personal', key: 'secret-two' },
    { name: 'Production', key: 'secret-one-rotated' },
  ]);
  const files = (await readdir(credentialDirectory)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 2);
  if (process.platform !== 'win32') {
    const fileStat = await stat(path.join(credentialDirectory, files[0]));
    assert.equal(fileStat.mode & 0o777, 0o600);
  }
  assert.equal(getCredentialDirectory({ platform: 'win32', home: 'C:\\Users\\test', env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' } }), 'C:\\Users\\test\\AppData\\Roaming\\v8-api-agent-skill\\credentials');
});

test('fails closed when a named credential file is corrupted', async () => {
  const directory = await temporaryDirectory();
  const credentialDirectory = path.join(directory, 'credentials');
  await saveCredential(credentialDirectory, { name: 'Corrupt me', key: 'secret' });
  const filename = `${createHash('sha256').update('Corrupt me').digest('hex')}.json`;
  await writeFile(path.join(credentialDirectory, filename), '{not-json');
  await assert.rejects(readCredentialStore(credentialDirectory), /凭据文件格式无效/);
});

test('helper rejects a credential whose filename does not match its key name', async () => {
  const directory = await temporaryDirectory();
  const credentialDirectory = path.join(directory, 'credentials');
  await saveCredential(credentialDirectory, { name: 'Production', key: 'secret' });
  const expectedName = `${createHash('sha256').update('Production').digest('hex')}.json`;
  const mismatchedName = `${createHash('sha256').update('Personal').digest('hex')}.json`;
  await rename(path.join(credentialDirectory, expectedName), path.join(credentialDirectory, mismatchedName));
  await assert.rejects(loadCredentials(credentialDirectory), /凭据文件格式无效/);
});

test('merges concurrent credentials instead of losing one update', async () => {
  const directory = await temporaryDirectory();
  const credentialDirectory = path.join(directory, 'config', 'credentials');
  await Promise.all([
    saveCredential(credentialDirectory, { name: 'Production', key: 'secret-one' }),
    saveCredential(credentialDirectory, { name: 'Personal', key: 'secret-two' }),
  ]);
  const store = await readCredentialStore(credentialDirectory);
  assert.deepEqual(store.credentials.sort((left, right) => left.name.localeCompare(right.name)), [
    { name: 'Personal', key: 'secret-two' },
    { name: 'Production', key: 'secret-one' },
  ]);
});

test('installs the skill and helper without replacing a user-owned version', async () => {
  const directory = await temporaryDirectory();
  const target = path.join(directory, '.agents', 'skills', 'v8-api');
  await installSkill(target);
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /name: v8-api/);
  assert.match(await readFile(path.join(target, 'scripts', 'v8-api.mjs'), 'utf8'), /https:\/\/api\.v8\.wiki/);
  await writeFile(path.join(target, 'SKILL.md'), '# customer customization\n');
  await assert.rejects(installSkill(target), /不同版本/);
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), '# customer customization\n');
});

test('allows only fixed V8 model routes and rejects host or method changes', () => {
  assert.equal(allowedRoute('GET', '/v1/models'), true);
  assert.equal(allowedRoute('POST', '/v1/chat/completions'), true);
  assert.equal(allowedRoute('POST', '/v1/images/generations'), true);
  assert.equal(allowedRoute('POST', '/v1/video/generations'), true);
  assert.equal(allowedRoute('GET', '/v1/video/generations/task_1'), true);
  assert.equal(allowedRoute('POST', '/v1/models'), false);
  assert.equal(allowedRoute('POST', 'https://attacker.example/collect'), false);
  assert.equal(allowedRoute('GET', '/v1/video/generations/task?host=attacker.example'), false);
});

test('sends the key only in the authorization header and redacts it from returned data', async () => {
  let request;
  const output = await sendRequest({
    method: 'POST', route: '/v1/chat/completions', key: 'secret-key-value', body: { model: 'model-1' },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response('{"note":"secret-key-value"}', { status: 200 });
    },
  });
  assert.equal(request.url, 'https://api.v8.wiki/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer secret-key-value');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.body, '{"model":"model-1"}');
  assert.equal(output, '{"note":"[redacted]"}');
  assert.equal(redact('secret-key-value', 'secret-key-value'), '[redacted]');
  assert.throws(() => selectCredential([{ name: 'Production', key: 'secret' }], 'Missing'), /找不到/);
});

test('does not expose an error response body that might contain a key', async () => {
  await assert.rejects(sendRequest({
    method: 'GET', route: '/v1/models', key: 'secret-key-value',
    fetchImpl: async () => new Response('secret-key-value', { status: 500 }),
  }), error => {
    assert.equal(error.message.includes('secret-key-value'), false);
    return /HTTP 500/.test(error.message);
  });
});

test('the installed helper lists names without printing saved keys', async () => {
  const directory = await temporaryDirectory();
  const configDirectory = path.join(directory, 'config');
  const credentialDirectory = path.join(configDirectory, 'v8-api-agent-skill', 'credentials');
  await saveCredential(credentialDirectory, { name: 'Production', key: 'must-never-appear-on-stdout' });
  const helperPath = fileURLToPath(new URL('../skill/scripts/v8-api.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [helperPath, 'keys'], {
    encoding: 'utf8',
    env: { ...process.env, APPDATA: configDirectory, XDG_CONFIG_HOME: configDirectory },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production/);
  assert.equal(result.stdout.includes('must-never-appear-on-stdout'), false);
  assert.equal(result.stderr.includes('must-never-appear-on-stdout'), false);
});
