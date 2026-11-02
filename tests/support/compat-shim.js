// Minimal shim: lets js/scrap-ledger.js (written for the Firebase *compat* API used by the pages)
// run on the *modular* Firestore instances that @firebase/rules-unit-testing hands out.
// Only what scrap-ledger.js and shift-close.js use: collection().doc(), ref.get(), ref.collection(), where().get(),
// db.runTransaction(tx.get / tx.set / tx.update / tx.delete).
const { doc, collection, getDoc, getDocs, query, where, runTransaction } = require('firebase/firestore');

const snapOf = s => ({ exists: s.exists(), id: s.id, data: () => s.data() });

function wrapRef(r) {
  return { id: r.id, _r: r, get: async () => snapOf(await getDoc(r)), collection: n => wrapCol(collection(r, n)) };
}
function wrapQuery(q, constraints) {
  return {
    where: (f, op, v) => wrapQuery(q, constraints.concat([where(f, op, v)])),
    get: async () => { const s = await getDocs(query(q, ...constraints)); return { size: s.size, forEach: fn => s.forEach(d => fn(snapOf(d))) }; }
  };
}
function wrapCol(c) {
  return { doc: id => wrapRef(id ? doc(c, id) : doc(c)), where: (f, op, v) => wrapQuery(c, [where(f, op, v)]), get: () => wrapQuery(c, []).get() };
}
function compatDb(fs) {
  return {
    collection: n => wrapCol(collection(fs, n)),
    runTransaction: fn => runTransaction(fs, t => fn({
      get: async ref => snapOf(await t.get(ref._r)),
      set: (ref, d) => t.set(ref._r, d),
      update: (ref, d) => t.update(ref._r, d),
      delete: ref => t.delete(ref._r)
    }))
  };
}
module.exports = { compatDb };
