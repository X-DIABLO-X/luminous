"use strict";
function defineQuery(query) {
  return query;
}
function groq(strings, ...keys) {
  const lastIndex = strings.length - 1;
  return strings.slice(0, lastIndex).reduce((acc, str, i) => acc + str + keys[i], "") + strings[lastIndex];
}
module.exports = groq;
Object.assign(module.exports, { defineQuery });
//# sourceMappingURL=groq.cjs.map
