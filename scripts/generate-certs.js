import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const certsDir = path.join(rootDir, 'certs');

if (!fs.existsSync(certsDir)) {
  fs.mkdirSync(certsDir, { recursive: true });
}

// Buscar openssl en PATH o en Git for Windows
let opensslBin = 'openssl';
try {
  execSync('openssl version', { stdio: 'ignore' });
} catch {
  const gitOpenssl = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  if (fs.existsSync(gitOpenssl)) {
    opensslBin = `"${gitOpenssl}"`;
  }
}

const keyPath = path.join(certsDir, 'key.pem');
const certPath = path.join(certsDir, 'cert.pem');
const cnfPath = path.join(certsDir, 'openssl.cnf');

const configContent = `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = localhost
O = Kortexa
OU = Local Development
C = MX

[v3_req]
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
`;

fs.writeFileSync(cnfPath, configContent);

try {
  const cmd = `${opensslBin} req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -config "${cnfPath}"`;
  execSync(cmd, { stdio: 'inherit' });
  console.log('\n🔒 Certificados SSL generados correctamente en:');
  console.log(`- Clave privada: ${keyPath}`);
  console.log(`- Certificado:   ${certPath}`);
} catch (err) {
  console.error('Error generando certificados con openssl:', err.message);
} finally {
  if (fs.existsSync(cnfPath)) {
    fs.unlinkSync(cnfPath);
  }
}
