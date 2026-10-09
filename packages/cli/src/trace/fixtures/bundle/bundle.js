// src/math.ts
function heavy(n) {
  let x = 0;
  for (let i = 0;i < n; i++)
    x = (x + Math.sqrt(i * 7919)) % 1e9;
  return x;
}
var square = (v) => v * v;

// src/util.ts
function work(rounds) {
  let total = 0;
  for (let r = 0;r < rounds; r++)
    total += heavy(200000) + square(r);
  return total;
}

// src/main.ts
var ticks = 0;
var timer = setInterval(() => {
  globalThis.fixtureResult = work(3);
  if (++ticks >= 200)
    clearInterval(timer);
}, 50);

//# debugId=54CD2C82AC13A94E64756E2164756E21
//# sourceMappingURL=bundle.js.map
