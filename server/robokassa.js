'use strict';
// Robokassa для подписки магазинов на платформу (Stage 5).
//
// Протокол мерчанта: ссылка на оплату собирается с SignatureValue =
// MD5(Login:OutSum:InvId:Password1); серверное уведомление Result проверяется
// по Password2, редиректы Success/Fail — по Password1. Сумма всегда с двумя
// знаками, подпись сравнивается без учёта регистра.
//
// Модуль не ходит в сеть и не знает про БД — только подписи и ссылки.
// Оркестрация (счета, подписки, приостановка) — в billing.js.

const crypto = require('node:crypto');

const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const fmtAmount = n => Number(n).toFixed(2);

// Сравнение подписей — константное по времени, как и везде в проекте.
// Обычный === выходил из строки посимвольно и в теории давал таймингу
// подсказку, какой префикс подписи угадан. Через сеть на MD5 это не вскрыть,
// но здесь дешевле быть последовательным, чем объяснять, почему единственное
// место с деньгами сравнивается иначе, чем всё остальное.
// Сравниваем sha256-дайджесты: длины всегда равны, а регистр Robokassa
// присылает как ей удобно, поэтому нормализуем заранее.
function same(a, b) {
  const da = crypto.createHash('sha256').update(String(a || '').toLowerCase()).digest();
  const db = crypto.createHash('sha256').update(String(b || '').toLowerCase()).digest();
  return crypto.timingSafeEqual(da, db);
}

function createRobokassa({ login, pass1, pass2, baseUrl = 'https://auth.robokassa.ru/Merchant/Index.aspx', isTest = false }) {
  if (!login || !pass1 || !pass2) throw new Error('robokassa: нужны login, pass1 и pass2');

  function payUrl({ amount, invId, description = '', successUrl = '', failUrl = '' }) {
    const out = fmtAmount(amount);
    const u = new URL(baseUrl);
    u.searchParams.set('MerchantLogin', login);
    u.searchParams.set('OutSum', out);
    u.searchParams.set('InvId', String(invId));
    if (description) u.searchParams.set('Description', String(description).slice(0, 100));
    if (successUrl) u.searchParams.set('SuccessURL', successUrl);
    if (failUrl) u.searchParams.set('FailURL', failUrl);
    u.searchParams.set('Culture', 'ru');
    u.searchParams.set('Encoding', 'utf-8');
    u.searchParams.set('SignatureValue', md5(`${login}:${out}:${invId}:${pass1}`).toUpperCase());
    if (isTest) u.searchParams.set('IsTest', '1');
    return u.toString();
  }

  // Подписи для входящих уведомлений и редиректов покупателя.
  const resultSig = (out, inv) => md5(`${out}:${inv}:${pass2}`);
  const successSig = (out, inv) => md5(`${out}:${inv}:${pass1}`);

  // OutSum берём строкой как пришёл: подпись считается от исходного текста,
  // и «990» с «990.00» дают разные дайджесты.
  const verifyResult = p => same(p.SignatureValue, resultSig(String(p.OutSum), String(p.InvId)));
  const verifySuccess = p => same(p.SignatureValue, successSig(String(p.OutSum), String(p.InvId)));

  return { payUrl, verifyResult, verifySuccess, formatAmount: fmtAmount };
}

module.exports = { createRobokassa };
