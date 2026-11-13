// The commands ./chat runs inside the app's container, for the person who runs the server.
//   node build/operator.mjs welcome              where the app is, and the first administrator's link
//   node build/operator.mjs admin-link [handle]  a new one-time link for an administrator
// They talk to a door that listens inside the container only (see operatorDoor in company.ts).
const door = `http://127.0.0.1:${Number(process.env.PORT ?? 8080) + 1}`;
const [command, handle] = process.argv.slice(2);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the door, waiting up to two minutes for the app to finish starting. */
async function ask(path, method = "GET") {
  let last = "The app did not answer.";
  let refused = false;
  for (let i = 0; i < 60 && !refused; i++) {
    try {
      const response = await fetch(door + path, { method });
      const body = await response.json();
      if (response.ok) return body;
      last = body.error ?? last;
      // Anything but "still starting" is the app's answer, and will not change by waiting.
      refused = response.status !== 503;
    } catch {
      // The app has not opened its door yet.
    }
    if (!refused) await sleep(2000);
  }
  console.error(last);
  if (!refused) console.error("See what the app says with: ./chat logs app");
  process.exit(1);
}

if (command === "welcome") {
  const info = await ask("/welcome");
  console.log(`${info.company} (${info.id}) is up.`);
  console.log(`  Chat:  ${info.address}`);
  if (info.open) console.log("         From another machine, use this server's name or address in place of localhost.");
  if (info.link) {
    console.log("");
    console.log(`  ${info.admin.name} is the first administrator. Open this link to choose a password:`);
    console.log(`  ${info.link}`);
    console.log("  It works once, for seven days. If it is lost, make another with: ./chat admin-link");
  } else if (info.unopened) {
    console.log("");
    console.log(`  ${info.admin.name}, the first administrator, has not opened their link yet. It was printed when the server first started.`);
    console.log("  If it is lost, make another with: ./chat admin-link");
  } else {
    console.log(`  People: ${info.people}. Sign in with your handle and password.`);
  }
} else if (command === "admin-link") {
  const info = await ask(`/admin-link${handle ? `?handle=${encodeURIComponent(handle)}` : ""}`, "POST");
  console.log(`A new link for ${info.name} (${info.id}). It works once, for seven days, and replaces any earlier link:`);
  console.log(info.link);
} else {
  console.error("usage: operator.mjs welcome | admin-link [handle]");
  process.exit(2);
}
