import path from 'node:path';
import { publicLiveOptions } from './memory-public-live-options.mjs';
export function structuredLiveOptions(args, root) {
  const extras = new Set(['--binary', '--production-source-root', '--frozen-memory-run', '--diagnostic-arm']);
  const remaining = [], values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-api-dry-run') { if (values.dryRun) throw new Error('Duplicate dry-run option'); values.dryRun = true; continue; }
    if (!extras.has(arg)) { remaining.push(arg); continue; }
    if (Object.hasOwn(values, arg)) throw new Error('Duplicate structured option');
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
    values[arg] = args[++i];
  }
  const options = publicLiveOptions(remaining, root);
  if (remaining.includes('--paragraph-control') || options.budgetAddendum) throw new Error('Structured round does not support paragraph control or budget addendum');
  const diagnosticArm = values['--diagnostic-arm'] ?? null, frozenMemoryRun = values['--frozen-memory-run'] ?? null;
  if (diagnosticArm && !['baseline', 'candidate'].includes(diagnosticArm)) throw new Error('Invalid diagnostic arm');
  if (!!diagnosticArm !== !!frozenMemoryRun || diagnosticArm && (options.split !== 'development' || options.tag !== `qa-structured-diag-${diagnosticArm}`)) throw new Error('Frozen memory is a separately tagged development diagnostic, never a gate candidate');
  if (options.tag?.startsWith('qa-structured-diag-') && !diagnosticArm) throw new Error('Diagnostic tag requires explicit arm and frozen memory');
  if (options.judges !== 'separated') throw new Error('Structured evaluation requires unchanged separated judges');
  return { ...options, noApiDryRun: values.dryRun === true, diagnosticArm,
    frozenMemoryRun: frozenMemoryRun ? path.resolve(root, frozenMemoryRun) : null,
    binary: path.resolve(root, values['--binary'] ?? `target/debug/${process.platform === 'win32' ? 'pm-host.exe' : 'pm-host'}`),
    productionSourceRoot: path.resolve(root, values['--production-source-root'] ?? '.') };
}
