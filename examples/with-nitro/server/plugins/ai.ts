// event.context.ai in every server route. In a Nitro or Nuxt project you can also write
// export default defineNitroPlugin(inferloAI(app.ai)).
import { inferloAI } from "../../../../src/h3.ts";
import { app } from "../inferlo/app.ts";

export default inferloAI(app.ai);
