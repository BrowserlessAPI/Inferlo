// node src/server.ts
import { makeServer } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
makeServer().listen(port, () => console.log(`with-express running on http://localhost:${port}`));
