/**
 * AES-256-ECB + PKCS7 using crypto-js.
 * Web Crypto in Workers does not support AES-ECB, so we use crypto-js.
 *
 * PHP openssl uses md5(...) hex string (32 ASCII chars) as the raw AES-256 key.
 */
import CryptoJS from 'crypto-js';

/** MD5 hex digest (lowercase). */
export function md5(text) {
  return CryptoJS.MD5(String(text)).toString(CryptoJS.enc.Hex);
}

/**
 * Decrypt JM API / domain payload.
 * key material = md5(ts + secret) as UTF-8 bytes (32-char hex string).
 * @param {string} b64 base64 ciphertext
 * @param {string} keyMaterial already-computed md5 hex OR use decryptWithSecret
 */
export function decryptWithKey(b64, keyHex) {
  const key = CryptoJS.enc.Utf8.parse(keyHex);
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: CryptoJS.enc.Base64.parse(b64),
  });
  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  const plain = decrypted.toString(CryptoJS.enc.Utf8);
  if (!plain) throw new Error('AES decrypt failed');
  return plain;
}

/** Decrypt API data field: key = md5(ts + DATA_SECRET). */
export function decryptApiData(b64, ts, dataSecret) {
  return decryptWithKey(b64, md5(ts + dataSecret));
}

/** Decrypt domain list: key = md5(DOMAIN_SECRET). */
export function decryptDomainBlob(b64, domainSecret) {
  return decryptWithKey(b64, md5(domainSecret));
}
