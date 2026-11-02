import 'dotenv/config';
import { initDatabase, closeDatabase, updateOutcome, listApplications, OUTCOMES } from '../core/database.js';

// Small CLI to record what happened to an application:
//   npm run result                    lists recent applications with their ids
//   npm run result <id> <outcome>     records the outcome

async function main(): Promise<void> {
  const [, , idArg, outcome] = process.argv;

  if (!idArg) {
    await initDatabase();
    const applications = listApplications(30);
    closeDatabase();
    console.log('Usage: npm run result <id> <outcome>');
    console.log(`Outcomes: ${OUTCOMES.join(', ')}\n`);
    console.log('Recent applications:');
    for (const a of applications) {
      console.log(`  [${a.id}] ${a.company} - ${a.jobTitle}  (${a.outcome ?? 'waiting'})`);
    }
    return;
  }

  const id = parseInt(idArg, 10);
  if (Number.isNaN(id)) {
    console.error(`Invalid id "${idArg}". Run "npm run result" without arguments to see the ids.`);
    process.exit(1);
  }
  if (!outcome || !OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
    console.error(`Invalid outcome "${outcome ?? ''}". Valid: ${OUTCOMES.join(', ')}`);
    process.exit(1);
  }

  await initDatabase();
  const ok = updateOutcome(id, outcome);
  closeDatabase();

  if (!ok) {
    console.error(`Application ${id} not found.`);
    process.exit(1);
  }
  console.log(`OK: application ${id} marked as "${outcome}".`);
}

main();
