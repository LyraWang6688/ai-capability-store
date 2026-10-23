import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBackendProbe } from '../src/doctor.mjs';

test('healthy when the backend exits 0 and prints something', () => {
  const result = evaluateBackendProbe({ code: 0, stdout: '0.2.1-rc.2\n', stderr: '' });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /有输出/);
});

test('exit 0 with empty output is the Node<24 trap and must fail', () => {
  const result = evaluateBackendProbe({ code: 0, stdout: '', stderr: '' });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /没有任何输出/);
  assert.match(result.hint, /Node <24/);
});

test('non-zero exit fails with the stderr snippet', () => {
  const result = evaluateBackendProbe({ code: 2, stdout: '', stderr: 'boom' });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /exit 2/);
  assert.match(result.detail, /boom/);
});

test('spawn errors fail without pretending to know the exit code', () => {
  const result = evaluateBackendProbe({ code: null, stdout: '', stderr: 'ENOENT' });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /spawn-error/);
});
