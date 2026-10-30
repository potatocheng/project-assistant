// Build a reviewable static manifest from the actual signed build outputs.
import {readFile,writeFile} from 'node:fs/promises';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: node scripts/update-manifest.mjs release-input.json latest.json');
const config=JSON.parse(await readFile(input,'utf8'));const pkg=JSON.parse(await readFile('package.json','utf8'));
const platforms={};
for(const artifact of config.artifacts??[]){
  if(!['windows-x86_64','darwin-aarch64','darwin-x86_64'].includes(artifact.platform)||platforms[artifact.platform])throw new Error('Unsupported or duplicate platform');
  if(new URL(artifact.url).protocol!=='https:')throw new Error('Artifact URL must use HTTPS');
  const signature=(await readFile(artifact.signatureFile,'utf8')).trim();
  if(!signature)throw new Error('Missing artifact signature');
  platforms[artifact.platform]={url:artifact.url,signature};
}
if(!Object.keys(platforms).length)throw new Error('No signed artifacts supplied');
await writeFile(output,JSON.stringify({version:pkg.version,notes:config.notes??'',pub_date:new Date().toISOString(),platforms},null,2)+'\n');
console.log('Manifest written. Verify signatures and URLs against staged installers before publishing.');
