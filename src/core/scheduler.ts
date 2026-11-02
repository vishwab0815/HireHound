import { log } from './logger.js';

// Runs the bot once a day at a fixed time. Enable with CRON_ENABLED=true and CRON_TIME=HH:MM.

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastRunDate = '';

export function startScheduler(time: string, run: () => Promise<void>): void {
  const [hour, minute] = time.split(':').map(Number);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    log('ERROR', `Scheduler: invalid time "${time}". Use HH:MM, e.g. 09:00`);
    return;
  }

  log('INFO', `Scheduler: will run every day at ${time}`);

  timer = setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const isTime = now.getHours() === hour && now.getMinutes() === minute;

    // Guard against overlapping runs and against firing twice in the same minute
    // (several 60s ticks can land in the target minute because of event loop drift).
    if (!isTime || running || lastRunDate === today) return;

    running = true;
    lastRunDate = today;
    log('INFO', 'Scheduler: starting scheduled run...');
    try {
      await run();
    } catch (error) {
      log('ERROR', `Scheduler: run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }, 60_000);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log('INFO', 'Scheduler stopped.');
  }
}
