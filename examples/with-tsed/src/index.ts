// Ts.ED needs TypeScript's decorator transform: compile with tsc (experimentalDecorators and
// emitDecoratorMetadata, see tsconfig.json), then run the output, for example node dist/index.js.
import { bootstrap } from "./main.ts";

const platform = await bootstrap(undefined, Number(process.env.PORT ?? 3000));
await platform.listen();
