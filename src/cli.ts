// Public CLI:
//   node dist/cli.js run --stage <1|2|3|4> [--events f] [--workers N] [--state-dir d] [--channel naive|dedup] [--out p]
//   node dist/cli.js recovery --scenario <crash-step|crash-send> [--events f] [--state-dir d] [--out p]
//   node dist/cli.js doctor --state-dir d
import { resolve } from 'node:path';
import { runStage, runRecovery, doctor } from './demo.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);

  if (cmd === 'run') {
    const stage = Number(a.stage);
    if (![1, 2, 3, 4].includes(stage)) throw new Error('--stage must be 1|2|3|4');
    await runStage({
      stage: stage as 1 | 2 | 3 | 4,
      eventsPath: resolve(a.events ?? 'fixtures/events.json'),
      stateDir: resolve(a['state-dir'] ?? 'state/demo'),
      workers: Number(a.workers ?? '2'),
      channel: (a.channel ?? 'naive') as 'naive' | 'dedup',
      outPath: a.out ? resolve(a.out) : undefined,
    });
    return;
  }

  if (cmd === 'recovery') {
    await runRecovery({
      scenario: (a.scenario ?? 'crash-step') as 'crash-step' | 'crash-send' | 'crash-claim',
      eventsPath: resolve(a.events ?? 'fixtures/events.json'),
      stateDir: resolve(a['state-dir'] ?? 'state/recovery'),
      outPath: a.out ? resolve(a.out) : undefined,
    });
    return;
  }

  if (cmd === 'doctor') {
    doctor(resolve(a['state-dir'] ?? 'state/demo'));
    return;
  }

  console.error('usage: run | recovery | doctor');
  process.exit(2);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
