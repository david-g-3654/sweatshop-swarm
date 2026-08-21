import { Orchestrator } from './orchestrator.js';
import { Rehearsal } from './rehearsal.js';
import { teardown } from './tools/deploy.js';
import * as recorder from './recorder.js';

/**
 * Headless runner, for rehearsing the canonical task from a terminal.
 *
 *   npm run rehearse
 *   npm run swarm -- --goal "build and deploy a URL shortener with analytics"
 */

const args = process.argv.slice(2);

/**
 * Read a flag's value, joining every word up to the next flag.
 *
 * `npm run swarm -- --goal "a b c"` loses the quoting on its way through npm,
 * so the goal arrives as separate argv entries. Taking only args[i+1] would
 * silently run with the goal "a".
 */
function flag(name: string, fallback: string): string {
  const start = args.indexOf(`--${name}`);
  if (start < 0) return fallback;
  const words: string[] = [];
  for (let i = start + 1; i < args.length && !args[i]!.startsWith('--'); i++) {
    words.push(args[i]!);
  }
  return words.length ? words.join(' ') : fallback;
}

const goal = flag('goal', 'Build and deploy a URL shortener with a real-time analytics dashboard showing clicks per link as a live-updating chart.');
const mode = args.includes('--rehearse') ? 'rehearsal' : 'live';
const keepAlive = args.includes('--keep-alive');

const driver = mode === 'rehearsal' ? new Rehearsal(goal, 0.35) : new Orchestrator({ goal });

driver.bus.subscribe((event) => {
  if (event.type === 'drama') {
    const mark = { info: '·', good: '✓', warn: '!', bad: '✗' }[event.level];
    console.log(`${mark} ${event.text}`);
  }
});

const outcome = await driver.run();
const file = await recorder.save(driver.bus.toRecording());

console.log(`\n${outcome.ok ? 'SUCCESS' : 'FAILED'} — ${driver.bus.log.length} events, recorded to ${file}`);
if (outcome.deployUrl) console.log(`live at: ${outcome.deployUrl}`);

if (keepAlive && outcome.deployUrl) {
  console.log('holding the deployment open — ctrl-c to stop');
  process.on('SIGINT', async () => {
    await teardown();
    process.exit(0);
  });
} else {
  await teardown();
  process.exit(outcome.ok ? 0 : 1);
}
