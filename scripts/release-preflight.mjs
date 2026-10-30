import {readFile,writeFile} from 'node:fs/promises';
const required=['PROJECT_ASSISTANT_UPDATE_URL','PROJECT_ASSISTANT_UPDATE_PUBKEY','TAURI_SIGNING_PRIVATE_KEY'];
if(process.platform==='win32')required.push('WINDOWS_CERTIFICATE_THUMBPRINT','WINDOWS_TIMESTAMP_URL');
else if(process.platform==='darwin')required.push('APPLE_SIGNING_IDENTITY','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID');
else throw new Error('Release packaging currently supports Windows and macOS.');
for(const key of required)if(!process.env[key]?.trim())throw new Error(`Missing release configuration: ${key}`);
if(new URL(process.env.PROJECT_ASSISTANT_UPDATE_URL).protocol!=='https:')throw new Error('Update endpoint must use HTTPS');
const pkg=JSON.parse(await readFile('package.json','utf8'));const config=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8'));
if(pkg.version!==config.version)throw new Error('Frontend and desktop release versions differ');
for(const path of ['crates/core/Cargo.toml','src-tauri/Cargo.toml']){const rust=await readFile(path,'utf8');if(!rust.includes(`version = "${pkg.version}"`))throw new Error(`Version differs: ${path}`);}
const overlay={bundle:{createUpdaterArtifacts:true}};
if(process.platform==='win32'){
  if(!/^[A-Fa-f0-9]{40}$/.test(process.env.WINDOWS_CERTIFICATE_THUMBPRINT))throw new Error('Invalid certificate thumbprint');
  new URL(process.env.WINDOWS_TIMESTAMP_URL);
  overlay.bundle.windows={certificateThumbprint:process.env.WINDOWS_CERTIFICATE_THUMBPRINT,digestAlgorithm:'sha256',timestampUrl:process.env.WINDOWS_TIMESTAMP_URL};
}
await writeFile('src-tauri/tauri.release.local.json',JSON.stringify(overlay,null,2));
console.log(`Release ${pkg.version}: required configuration present. Signing and notarization must still succeed during packaging.`);
