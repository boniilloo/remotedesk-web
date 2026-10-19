// First module evaluated: refuse to run inside a frame (clickjacking). GitHub Pages cannot
// send frame-ancestors and a <meta> CSP ignores it. Throwing here stops the whole module
// graph, and every screen starts hidden, so a framed copy shows nothing usable.
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  throw new Error('RemoteDesk no se puede usar dentro de otra página.');
}
