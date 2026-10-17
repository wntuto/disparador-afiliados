import cron, { type ScheduledTask } from 'node-cron';
import type { Repo } from './db.ts';
import type { Dispatcher } from './dispatcher.ts';

// Agendador:
//  - campanhas "once": verificadas a cada minuto; disparam quando run_at já passou.
//  - campanhas "recurring": cada uma vira uma tarefa node-cron com sua expressão (fuso do TZ).
// sync() é chamado no início, a cada minuto e sempre que uma campanha muda.

export function createScheduler(repo: Repo, dispatcher: Dispatcher, timezone: string, log = console) {
  const tasks = new Map<number, { cron: string; task: ScheduledTask }>();
  let ticker: ScheduledTask | null = null;

  async function runSafe(campaignId: number) {
    const c = repo.getCampaign(campaignId);
    if (!c || !c.active) return;
    try {
      const r = await dispatcher.runCampaign(c);
      log.info(`[agendador] campanha #${c.id} "${c.name}": ${r.sent} enviados, ${r.failed} falhas`);
    } catch (err) {
      log.error(`[agendador] campanha #${c.id} falhou:`, err);
    }
  }

  function sync() {
    const wanted = new Map(repo.activeRecurringCampaigns().map((c) => [c.id, c.cron ?? '']));
    for (const [id, t] of tasks) {
      if (wanted.get(id) !== t.cron) {
        t.task.stop();
        tasks.delete(id);
      }
    }
    for (const [id, expr] of wanted) {
      if (tasks.has(id) || !cron.validate(expr)) continue;
      tasks.set(id, { cron: expr, task: cron.schedule(expr, () => runSafe(id), { timezone }) });
    }
  }

  async function tick() {
    sync();
    for (const c of repo.dueOnceCampaigns(new Date().toISOString())) await runSafe(c.id);
  }

  return {
    sync,
    tick,
    start() {
      sync();
      ticker = cron.schedule('* * * * *', tick, { timezone });
      void tick();
    },
    stop() {
      ticker?.stop();
      for (const t of tasks.values()) t.task.stop();
      tasks.clear();
    },
    scheduledCount: () => tasks.size,
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
