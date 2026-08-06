'use strict';
// Тесты тормоза на подбор пароля админки.

const test = require('node:test');
const assert = require('node:assert');
const guard = require('../server/authguard');

test('первые попытки бесплатны — человек ошибается раскладкой', () => {
  guard.reset();
  for (let i = 0; i < guard.FREE_TRIES; i++) {
    assert.strictEqual(guard.check('1.1.1.1').allowed, true, `попытка ${i + 1} должна проходить`);
    const r = guard.fail('1.1.1.1');
    assert.strictEqual(r.retryAfterMs, 0, `на попытке ${i + 1} паузы быть не должно`);
  }
});

test('после лимита адрес уходит в паузу', () => {
  guard.reset();
  for (let i = 0; i < guard.FREE_TRIES; i++) guard.fail('2.2.2.2');
  const r = guard.fail('2.2.2.2');
  assert.strictEqual(r.retryAfterMs, guard.BASE_MS);
  const gate = guard.check('2.2.2.2');
  assert.strictEqual(gate.allowed, false);
  assert.ok(gate.retryAfterMs > 0);
});

test('пауза удваивается и упирается в потолок', () => {
  guard.reset();
  const { lockFor } = guard._internal;
  assert.strictEqual(lockFor(guard.FREE_TRIES), 0);
  assert.strictEqual(lockFor(guard.FREE_TRIES + 1), guard.BASE_MS);
  assert.strictEqual(lockFor(guard.FREE_TRIES + 2), guard.BASE_MS * 2);
  assert.strictEqual(lockFor(guard.FREE_TRIES + 3), guard.BASE_MS * 4);
  assert.strictEqual(lockFor(guard.FREE_TRIES + 50), guard.MAX_MS, 'бесконечно расти нельзя');
});

test('пауза истекает сама', () => {
  guard.reset();
  for (let i = 0; i <= guard.FREE_TRIES; i++) guard.fail('3.3.3.3');
  assert.strictEqual(guard.check('3.3.3.3').allowed, false);
  // проверяем логику времени, а не ждём реальную минуту
  const later = Date.now() + guard.BASE_MS + 1000;
  assert.strictEqual(guard.check('3.3.3.3', later).allowed, true);
});

test('удачный вход обнуляет счётчик', () => {
  guard.reset();
  for (let i = 0; i <= guard.FREE_TRIES; i++) guard.fail('4.4.4.4');
  assert.strictEqual(guard.check('4.4.4.4').allowed, false);
  guard.succeed('4.4.4.4');
  assert.strictEqual(guard.check('4.4.4.4').allowed, true);
});

test('адреса считаются раздельно', () => {
  guard.reset();
  for (let i = 0; i <= guard.FREE_TRIES; i++) guard.fail('5.5.5.5');
  assert.strictEqual(guard.check('5.5.5.5').allowed, false);
  assert.strictEqual(guard.check('6.6.6.6').allowed, true, 'сосед по IP не должен страдать');
});
