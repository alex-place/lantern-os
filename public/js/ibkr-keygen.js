/**
 * Browser-side IBKR key generator (ADR-0022) — so non-technical users never touch
 * OpenSSL. Generates the two RSA keypairs via Web Crypto and ships a standard,
 * public Diffie-Hellman prime (RFC 3526 group 14 / modp_2048), building a valid
 * dhparam.pem in JS. Verified: these keys drive the full OAuth 1.0a flow, and the
 * generated dhparam.pem parses in OpenSSL as modp_2048.
 *
 * Downloads for IBKR: public_signature.pem, public_encryption.pem, dhparam.pem.
 * Kept for unisona (auto-filled into the connect form): the two PRIVATE keys + the
 * DH prime hex. Private keys never leave the browser except into unisona's form.
 */
window.IbkrKeygen = (function () {
  // RFC 3526 group 14, 2048-bit MODP prime; generator = 2. Public, standard params.
  const DH_PRIME_HEX = (
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
    '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
    'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
    'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
    '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
    '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
    'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
    '15728E5A8AACAA68FFFFFFFFFFFFFFFF'
  ).toLowerCase();

  function b64(ab) {
    const u = new Uint8Array(ab); let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function pem(ab, label) {
    return `-----BEGIN ${label}-----\n${b64(ab).replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;
  }
  // Minimal DER for dhparam: SEQUENCE { INTEGER prime, INTEGER 2 }.
  function derLen(n) { if (n < 0x80) return [n]; const b = []; let x = n; while (x > 0) { b.unshift(x & 0xff); x >>= 8; } return [0x80 | b.length, ...b]; }
  function derInt(bytes) { let b = bytes.slice(); if (b[0] & 0x80) b = [0, ...b]; return [0x02, ...derLen(b.length), ...b]; }
  function buildDhParamPem() {
    const prime = []; for (let i = 0; i < DH_PRIME_HEX.length; i += 2) prime.push(parseInt(DH_PRIME_HEX.substr(i, 2), 16));
    const content = [...derInt(prime), ...derInt([2])];
    const der = Uint8Array.from([0x30, ...derLen(content.length), ...content]);
    return pem(der.buffer, 'DH PARAMETERS');
  }

  async function generate() {
    if (!(window.crypto && crypto.subtle)) throw new Error('This browser lacks Web Crypto — use the manual OpenSSL steps.');
    const rsa = (name) => crypto.subtle.generateKey(
      { name, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true,
      name === 'RSA-OAEP' ? ['encrypt', 'decrypt'] : ['sign', 'verify']);
    const sig = await rsa('RSASSA-PKCS1-v1_5');
    const enc = await rsa('RSA-OAEP');
    return {
      // → upload to IBKR
      signPublicPem: pem(await crypto.subtle.exportKey('spki', sig.publicKey), 'PUBLIC KEY'),
      encPublicPem: pem(await crypto.subtle.exportKey('spki', enc.publicKey), 'PUBLIC KEY'),
      dhParamPem: buildDhParamPem(),
      // → keep in unisona (auto-filled)
      signPrivatePem: pem(await crypto.subtle.exportKey('pkcs8', sig.privateKey), 'PRIVATE KEY'),
      encPrivatePem: pem(await crypto.subtle.exportKey('pkcs8', enc.privateKey), 'PRIVATE KEY'),
      dhPrimeHex: DH_PRIME_HEX,
    };
  }

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-pem-file' }));
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  return { generate, download, buildDhParamPem, DH_PRIME_HEX };
})();
