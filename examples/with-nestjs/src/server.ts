// NestJS needs TypeScript's decorator transform: compile with tsc (experimentalDecorators and
// emitDecoratorMetadata, see tsconfig.json), then run the output, for example node dist/server.js.
import { bootstrap } from "./main.ts";

const nest = await bootstrap();
await nest.listen(Number(process.env.PORT ?? 3000));
