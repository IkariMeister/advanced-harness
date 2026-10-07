import { Plugin } from '@opencode/plugin/tui';
import { Approval } from './rpc.ts';

/** Explicit user-operated approval UI. No approval tool is registered in the server agent catalog. */
export default Plugin.define({
  id: 'advanced-harness.approval-ui-spike',
  setup(context) {
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [{
        id: 'advanced-harness.review-plan',
        title: 'Review harness plan',
        group: 'Advanced Harness',
        palette: true,
        suggested: true,
        enabled: () => true,
        run: async () => {
          const location = context.location ?? context.data.location.default();
          const rpc = context.client.rpc(Approval);
          const pending = await rpc.pending({}, { location }) as {
            pending: boolean; plan: string; target: string; approved: boolean;
          };
          if (!pending.pending || pending.approved) {
            await context.ui.dialog.alert({ title: 'Advanced Harness', message: 'There is no unapproved plan.' });
            return;
          }
          const challenge = await rpc.challenge({ target: pending.target }, { location }) as { nonce: string };
          const confirmed = await context.ui.dialog.confirm({
            title: 'Approve plan revision?',
            message: `${pending.plan}\n\nRevision: ${pending.target}\n\nApproving permits only the exact current plan revision.`,
            label: { confirm: 'Approve this revision', cancel: 'Cancel' },
          });
          if (!confirmed) {
            await context.ui.dialog.alert({ title: 'Advanced Harness', message: 'Approval cancelled; no gate was opened.' });
            return;
          }
          await rpc.approve({ target: pending.target, nonce: challenge.nonce }, { location });
          await context.ui.dialog.alert({ title: 'Advanced Harness', message: `Approved revision ${pending.target}.` });
        },
      }],
      bindings: ['advanced-harness.review-plan'],
    }));
  },
});
