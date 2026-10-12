import { CronExpressionParser } from 'cron-parser';
import type { Store } from './store.js';

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly store: Store) {}
  tick(at = new Date()): void {
    const minute = Math.floor(at.getTime() / 60000) * 60000;
    for (const schedule of this.store.list('schedules')) {
      if (schedule.enabled !== 1) continue;
      try {
        const previous = CronExpressionParser.parse(String(schedule.cron), {
          tz: String(schedule.timezone), currentDate: new Date(minute + 1000)
        }).prev().getTime();
        // 중지 기간의 모든 일정을 재생하지 않고 가장 최근 한 회차만 접수한다.
        if (previous <= minute && minute - previous <= 86400000) this.store.wake(String(schedule.manager_id), previous, 'cron');
      } catch (error) { process.stderr.write(`schedule error: ${String(error)}\n`); }
    }
    for (const workflow of this.store.list('work_processes')) {
      if (workflow.status !== 'active') continue;
      try {
        const latest = this.store.row('SELECT MAX(scheduled_at) AS scheduled_at FROM work_cycles WHERE process_id=?', String(workflow.id));
        const start = Number(latest?.scheduled_at ?? workflow.created_at);
        const iterator = CronExpressionParser.parse(String(workflow.cron), { tz: String(workflow.timezone), currentDate: new Date(start) });
        for (let count = 0; count < 500; count++) {
          const due = iterator.next().getTime();
          if (due > minute) break;
          this.store.cycleEnsure(String(workflow.id), due, at.getTime());
        }
        // 기한을 넘긴 미처리 회차만 missed로 갱신한다.
        for (const cycle of this.store.rows("SELECT * FROM work_cycles WHERE process_id=? AND outcome='due' LIMIT 500", String(workflow.id))) this.store.cycleEnsure(String(workflow.id), Number(cycle.scheduled_at), at.getTime());
      } catch (error) { process.stderr.write(`work process error: ${String(error)}\n`); }
    }
  }
  start(): void { this.tick(); this.timer = setInterval(() => this.tick(), 30000); this.timer.unref(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
