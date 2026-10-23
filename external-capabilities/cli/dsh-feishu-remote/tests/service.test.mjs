import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SERVICE_PATH, buildServiceScript, buildSystemdUnit } from '../src/service.mjs';

const base = {
  workdir: '/srv/work',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  keychainService: 'DEEPSEEK_API_KEY',
  extraEnv: {},
};

const linux = { nodePath: '/opt/runtime/bin/node', cliPath: '/opt/pkg/bin/cli.mjs', platform: 'linux' };
const darwin = { nodePath: '/opt/runtime/bin/node', cliPath: '/opt/pkg/bin/cli.mjs', platform: 'darwin' };

test('config extraEnv.PATH wins over the default PATH', () => {
  const script = buildServiceScript(
    { ...base, extraEnv: { PATH: '/opt/runtime/bin:/usr/bin:/bin' } },
    linux,
  );
  assert.match(script, /^export PATH="\/opt\/runtime\/bin:\/usr\/bin:\/bin"$/m);
  assert.ok(!script.includes(DEFAULT_SERVICE_PATH));
});

test('default PATH is used when the config does not override it', () => {
  const script = buildServiceScript(base, linux);
  assert.ok(script.includes(DEFAULT_SERVICE_PATH));
});

test('linux launcher sources the env file instead of the keychain', () => {
  const script = buildServiceScript(base, linux);
  assert.match(script, /set -a && \. ".*\/env" && set \+a/);
  assert.ok(!script.includes('security find-generic-password'));
  assert.ok(!script.includes('caffeinate'));
  assert.match(script, /exec "\/opt\/runtime\/bin\/node" "\/opt\/pkg\/bin\/cli\.mjs" run >>/);
});

test('macOS launcher keeps the keychain lookup and caffeinate', () => {
  const script = buildServiceScript(base, darwin);
  assert.match(script, /security find-generic-password/);
  assert.match(script, /caffeinate -dimsu/);
  assert.ok(!script.includes('set -a; . '));
});

test('macOS launcher skips the keychain when keychainService is empty', () => {
  const script = buildServiceScript({ ...base, keychainService: '' }, darwin);
  assert.ok(!script.includes('security find-generic-password'));
  assert.match(script, /caffeinate/);
});

test('systemd unit is restarted by the user manager and survives reboots', () => {
  const unit = buildSystemdUnit(base);
  assert.match(unit, /^ExecStart=\/bin\/bash .*service\.sh$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WorkingDirectory=\/srv\/work$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});
