// Convert PEM-encoded cert + private key into a PKCS12 bundle that native code can import.
// We use node-forge — it handles PKCS#1, PKCS#8, EC and RSA keys uniformly.

import forge from 'node-forge';

export type PKCS12Bundle = {
  pkcs12Base64: string;
  pkcs12Password: string;
};

// A fixed password is fine because the PKCS12 only lives in our local SecureStore.
// Using a static password keeps the PKCS12 byte representation stable for caching.
const PKCS12_PASSWORD = 'sextant-local';

export function buildPKCS12FromPEM(certPem: string, keyPem: string): PKCS12Bundle {
  const cert = forge.pki.certificateFromPem(certPem);
  const privateKey = forge.pki.privateKeyFromPem(keyPem);
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], PKCS12_PASSWORD, {
    algorithm: '3des',
    friendlyName: 'sextant',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return {
    pkcs12Base64: forge.util.encode64(der),
    pkcs12Password: PKCS12_PASSWORD,
  };
}

// Convert a PEM bundle (which may contain multiple CA certs) into one base64-DER string per cert.
export function caPEMtoDerB64(pem: string): string[] {
  const out: string[] = [];
  // Crude PEM splitter — works for the standard "-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----" blocks.
  const re = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem)) !== null) {
    const b64 = m[1].replace(/\s+/g, '');
    out.push(b64);
  }
  return out;
}
