export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTokenRefresher } = await import("./server/token-refresher");
  startTokenRefresher();
}
