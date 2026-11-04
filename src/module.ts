/**
 * Feature modules split a large app into parts with explicit dependencies. A module is a plain value:
 * its models, routes and jobs, the modules it depends on, and what it offers other modules.
 *
 *   export const billing = module("billing", {
 *     imports: [users],                       // modules this one uses
 *     models: [invoices],
 *     routes: [invoiceRoutes],                // import * as invoiceRoutes from "./routes.ts"
 *     jobs: [sendInvoice],
 *     provides: { createInvoice },            // what other modules may use: billing.provides.createInvoice
 *   });
 *
 *   createApp({ modules: [users, billing] })
 *
 * No decorators, no container, no injection: other modules import the module value and call
 * billing.provides.createInvoice(...) directly. createApp checks that every imported module is
 * registered and that models only reference models of their own module, an imported module or the
 * app itself, and describe() shows each module with what it contains.
 */
import { InferloError, didYouMean } from "./errors.ts";
import type { JobSource } from "./jobs.ts";
import type { AnyModel } from "./model.ts";
import type { RouteSource } from "./app.ts";
import type { AnySchema } from "./schema.ts";

const MODULE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const OPTION_KEYS = new Set(["description", "imports", "models", "routes", "jobs", "provides"]);

export interface ModuleOptions<Models extends readonly AnyModel[] = readonly AnyModel[], Provides extends Record<string, unknown> = Record<string, unknown>> {
  /** One sentence about what the module does, shown in describe() and as the OpenAPI tag description. */
  description?: string;
  /** Modules this module depends on. Each must also be passed to createApp({ modules }). */
  imports?: readonly AnyModule[];
  /** The models (tables) this module owns. */
  models?: Models;
  /** The module's routes: routes, arrays or route files (import * as invoices from "./routes/invoices.ts"). */
  routes?: readonly RouteSource[];
  /** The module's background jobs and crons. */
  jobs?: readonly JobSource[];
  /** What other modules may use, by name: plain functions and values, read as billing.provides.createInvoice. */
  provides?: Provides;
}

export interface Module<Name extends string = string, Models extends readonly AnyModel[] = readonly AnyModel[], Provides extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: "inferlo.module";
  readonly name: Name;
  readonly description?: string;
  readonly imports: readonly AnyModule[];
  readonly models: Models;
  readonly routes: readonly RouteSource[];
  readonly jobs: readonly JobSource[];
  readonly provides: Readonly<Provides>;
}

export type AnyModule = Module<string, readonly AnyModel[], any>;

/** The models of a list of modules, in order: ModuleModels<[typeof users, typeof billing]>. */
export type ModuleModels<M extends readonly AnyModule[]> = M extends readonly [infer H extends AnyModule, ...infer R extends readonly AnyModule[]]
  ? [...H["models"], ...ModuleModels<R>]
  : M extends readonly [] ? [] : M[number]["models"][number][];

function invalid(message: string, fix: string): InferloError {
  return new InferloError("IL6022", message, { fix });
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Define a feature module: module("billing", { imports, models, routes, jobs, provides }).
 * Register it with createApp({ modules: [billing] }).
 */
export function module<const Name extends string, const Models extends readonly AnyModel[] = [], const Provides extends Record<string, unknown> = {}>(
  name: Name,
  options: ModuleOptions<Models, Provides> = {},
): Module<Name, Models, Provides> {
  if (typeof name !== "string" || !MODULE_NAME.test(name)) {
    throw invalid(`Module name ${JSON.stringify(name)} is not valid.`, 'Use lowercase letters, digits and dashes, starting with a letter: module("billing", { ... }).');
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalid(`module("${name}") options must be an object.`, `Use module("${name}", { models, routes, jobs, imports, provides }).`);
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw invalid(`module("${name}") has an unknown option "${key}".${didYouMean(key, OPTION_KEYS)}`, "A module takes description, imports, models, routes, jobs and provides.");
    }
  }
  for (const key of ["imports", "models", "routes", "jobs"] as const) {
    if (options[key] !== undefined && !isList(options[key])) {
      throw invalid(`module("${name}") ${key} must be an array.`, `Use module("${name}", { ${key}: [...] }).`);
    }
  }
  if (options.description !== undefined && typeof options.description !== "string") {
    throw invalid(`module("${name}") description must be a string.`, "Describe the module in one sentence.");
  }
  const imports = options.imports ?? [];
  for (const [i, dep] of imports.entries()) {
    if (!isModule(dep)) {
      throw invalid(`module("${name}") imports[${i}] is not a module.`, "List module values created with module(), for example imports: [users].");
    }
    if (dep.name === name) throw invalid(`module("${name}") imports itself.`, `Remove "${name}" from its own imports.`);
  }
  if (new Set(imports.map((m) => m.name)).size !== imports.length) {
    throw invalid(`module("${name}") imports the same module twice.`, "List each module once in imports.");
  }
  for (const [i, m] of (options.models ?? []).entries()) {
    if (typeof m !== "object" || m === null || typeof (m as AnyModel).name !== "string" || typeof (m as AnyModel).fields !== "object") {
      throw invalid(`module("${name}") models[${i}] is not a model.`, 'List models created with model("table", { ... }).');
    }
  }
  const provides = options.provides ?? ({} as Provides);
  if (typeof provides !== "object" || provides === null || Array.isArray(provides)) {
    throw invalid(`module("${name}") provides must be an object.`, `Use provides: { createInvoice } and call ${name}.provides.createInvoice(...) from other modules.`);
  }
  return Object.freeze({
    kind: "inferlo.module",
    name,
    ...(options.description !== undefined ? { description: options.description } : {}),
    imports: Object.freeze([...imports]),
    models: Object.freeze([...(options.models ?? [])]) as unknown as Models,
    routes: Object.freeze([...(options.routes ?? [])]),
    jobs: Object.freeze([...(options.jobs ?? [])]),
    provides: Object.freeze({ ...provides }),
  });
}

export function isModule(value: unknown): value is AnyModule {
  return typeof value === "object" && value !== null && (value as AnyModule).kind === "inferlo.module";
}

function wiring(message: string, fix: string): InferloError {
  return new InferloError("IL6023", message, { fix });
}

/**
 * Checks createApp({ modules }) and returns the modules with each model's owner. Every imported
 * module must be registered, names are unique, and a model may only reference models of its own
 * module, of a module it imports, or of the app itself (createApp({ models })).
 */
export function resolveModules(option: unknown, appModels: readonly AnyModel[]): { modules: readonly AnyModule[]; modelOwner: Map<string, string> } {
  if (option === undefined) return { modules: [], modelOwner: new Map() };
  if (!isList(option)) throw wiring("createApp({ modules }) must be an array of modules.", "Use createApp({ modules: [users, billing] }).");
  const byName = new Map<string, AnyModule>();
  for (const [i, m] of option.entries()) {
    if (!isModule(m)) throw wiring(`createApp({ modules }) item ${i} is not a module.`, 'Create modules with module("name", { ... }) and pass the values: modules: [users, billing].');
    const existing = byName.get(m.name);
    if (existing === m) throw wiring(`The module "${m.name}" is listed twice in createApp({ modules }).`, "List each module once.");
    if (existing) throw wiring(`Two modules are named "${m.name}".`, "Module names must be unique.");
    byName.set(m.name, m);
  }
  for (const m of byName.values()) {
    for (const dep of m.imports) {
      const registered = byName.get(dep.name);
      if (!registered) {
        throw wiring(`The module "${m.name}" imports "${dep.name}", which is not in createApp({ modules }).`, `Add ${dep.name} to createApp({ modules: [...] }).`);
      }
      if (registered !== dep) throw wiring(`The module "${m.name}" imports a different module also named "${dep.name}".`, "Import the same module value that is passed to createApp({ modules }).");
    }
  }

  const modelOwner = new Map<string, string>();
  for (const m of byName.values()) {
    for (const model of m.models) {
      const owner = modelOwner.get(model.name);
      if (owner !== undefined) {
        throw wiring(`The model "${model.name}" is in the modules "${owner}" and "${m.name}".`, "A model belongs to one module; other modules import that module to use it.");
      }
      modelOwner.set(model.name, m.name);
    }
  }
  for (const model of appModels) {
    const owner = modelOwner.get(model.name);
    if (owner !== undefined) throw wiring(`The model "${model.name}" is in createApp({ models }) and in the module "${owner}".`, "List the model in one place only.");
  }

  for (const m of byName.values()) {
    const allowed = new Set([m.name, ...m.imports.map((d) => d.name)]);
    for (const model of m.models) {
      for (const [field, schema] of Object.entries(model.fields as Record<string, AnySchema>)) {
        const ref = schema.def.refTable;
        const owner = ref ? modelOwner.get(ref) : undefined;
        if (owner !== undefined && !allowed.has(owner)) {
          throw new InferloError("IL6024", `${model.name}.${field} in the module "${m.name}" references "${ref}" from the module "${owner}", which "${m.name}" does not import.`, {
            fix: `Add ${owner} to the imports of the "${m.name}" module: module("${m.name}", { imports: [${owner}], ... }).`,
          });
        }
      }
    }
  }
  return { modules: [...byName.values()], modelOwner };
}

/** Which module each route, model and job came from (for describe() and OpenAPI). */
export interface ModuleInfo {
  modules: readonly AnyModule[];
  routeModule: ReadonlyMap<unknown, string>;
  modelOwner: ReadonlyMap<string, string>;
  jobModule: ReadonlyMap<string, string>;
}
