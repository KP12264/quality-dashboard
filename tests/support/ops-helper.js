// Opens a go-live operation run (qdOpsLog START, Phase 9) for a test actor { db, opts } and returns
// opts with its opId — the rules require one for reconcile / baseline / gate / privacy migration.
const OPS = require('../../tools/ops/bridge-ops.js');
async function op(actor, action) {
  const opId = await OPS.startOp(actor.db, action, { approvalRef: 'TEST-OP', reason: 'automated test', projectId: 'demo-quality-dashboard' }, actor.opts);
  return Object.assign({}, actor.opts, { opId });
}
module.exports = { op };
