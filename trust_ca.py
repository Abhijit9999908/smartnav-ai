#!/usr/bin/env python3
"""
trust_ca.py — Install SmartNav mkcert CA into Chrome/Chromium NSS DB.
Run once after generating certs, or after Chrome updates reset the store.
Usage: python3 trust_ca.py
"""
import ctypes, ctypes.util, os, base64, re, sys

NSS_DB  = os.path.expanduser("~/.pki/nssdb")
CA_FILE = os.path.join(os.path.dirname(__file__), "certs", "ca", "rootCA.pem")
NICK    = "SmartNav-mkcert-CA"

def main():
    if not os.path.exists(CA_FILE):
        print(f"ERROR: CA file not found: {CA_FILE}")
        sys.exit(1)
    if not os.path.exists(NSS_DB):
        print(f"ERROR: Chrome NSS DB not found: {NSS_DB}")
        sys.exit(1)

    nss = ctypes.CDLL(ctypes.util.find_library('nss3'))
    rv  = nss.NSS_InitReadWrite(f"sql:{NSS_DB}".encode())
    if rv != 0:
        print(f"NSS init failed: {rv}"); sys.exit(1)

    with open(CA_FILE) as f: pem = f.read()
    der = base64.b64decode(re.sub(r'-----[^-]+-----|\s', '', pem))
    der_buf = (ctypes.c_uint8 * len(der))(*der)

    class SECItem(ctypes.Structure):
        _fields_ = [('type', ctypes.c_uint), ('data', ctypes.c_void_p), ('len', ctypes.c_uint)]
    item     = SECItem(0, ctypes.addressof(der_buf), len(der))
    item_arr = (ctypes.POINTER(SECItem) * 1)(ctypes.pointer(item))
    db       = nss.CERT_GetDefaultCertDB()

    nss.CERT_ImportCerts(db, 4, 1, item_arr, None, 1, 1, NICK.encode())

    cert = nss.CERT_FindCertByNickname(db, NICK.encode())
    if not cert:
        print("Import failed"); nss.NSS_Shutdown(); sys.exit(1)

    class CERTCertTrust(ctypes.Structure):
        _fields_ = [('sslFlags', ctypes.c_uint), ('emailFlags', ctypes.c_uint), ('objectSigningFlags', ctypes.c_uint)]
    trust = CERTCertTrust(0x18, 0, 0)
    nss.CERT_ChangeCertTrust(db, ctypes.c_void_p(cert), ctypes.byref(trust))
    nss.CERT_DestroyCertificate(ctypes.c_void_p(cert))
    nss.NSS_Shutdown()
    print(f"SUCCESS: '{NICK}' trusted in Chrome. Restart Chrome to apply.")

if __name__ == '__main__':
    main()
