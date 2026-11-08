/**
 * GraphQL: a /graphql endpoint whose queries and mutations are the app's routes.
 *
 *   import { graphqlRoute } from "@browserlessapi/inferlo/graphql";
 *   import { listNotes, getNote, createNote } from "./notes.ts";
 *
 *   export const graphql = graphqlRoute({
 *     query: { notes: listNotes, note: getNote },
 *     mutation: { createNote },
 *   });
 *
 * Each field runs its route in the same process as the caller, with the route's auth, permissions, validation,
 * rate limits, tenant scope and audit, so GraphQL never bypasses a rule the REST route has. Field arguments are the
 * route's path params, query and body; field types come from the route's response schema (the JSON scalar without
 * one). Needs graphql 16 or later (an optional peer dependency).
 */
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  NoSchemaIntrospectionCustomRule,
  execute,
  parse,
  specifiedRules,
  validate,
  valueFromASTUntyped,
  type ASTVisitor,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLFieldConfig,
  type GraphQLInputType,
  type GraphQLOutputType,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from "graphql";
import { routeToolsOf } from "./ai/index.ts";
import { InferloError } from "./errors.ts";
import { toolDefinition } from "./mcp.ts";
import { route, type Auth, type RouteDef } from "./route.ts";
import type { RateLimit } from "./rate-limit.ts";
import { t } from "./schema.ts";

export interface GraphQLRouteOptions {
  /** Query fields: name to a route, usually GET routes ({ notes: listNotes, note: getNote }). */
  query: Record<string, RouteDef>;
  /** Mutation fields: name to a route, usually POST, PUT, PATCH and DELETE routes ({ createNote }). */
  mutation?: Record<string, RouteDef>;
  /** Path of the endpoint. Default "/graphql". */
  path?: string;
  /**
   * Who may call the endpoint. Default "user" (signed in). Each field's route still checks its own auth, so with
   * "public" anonymous callers reach only the public routes.
   */
  auth?: Auth;
  /** Limit requests to the endpoint per user or IP, on top of the limits of each field's route. */
  rateLimit?: RateLimit;
  /** Answer introspection queries (__schema, __type). Default true; set false to hide the schema in production. */
  introspection?: boolean;
  /** Most top-level fields (aliases count) one request may ask for, since each runs a route. Default 20. */
  maxFields?: number;
}

type JSONSchema = Record<string, any>;
interface FieldContext {
  run: (route: RouteDef, input: unknown) => Promise<{ status: number; output: unknown; text: string }>;
}

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const invalid = (message: string, fix: string) => new InferloError("IL6059", message, { fix });
const pascal = (name: string) => name.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase());

/** Any JSON value: fields without a response schema, json and any fields, and shapes GraphQL cannot describe. */
export const GraphQLJSON = new GraphQLScalarType({
  name: "JSON",
  description: "Any JSON value.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast, variables) => valueFromASTUntyped(ast, variables ?? undefined),
});

/** The type of a JSON Schema without null, and whether null is allowed. */
function nullability(schema: JSONSchema): { schema: JSONSchema; nullable: boolean } {
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    const rest = schema.type.filter((x: string) => x !== "null");
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.some((o: JSONSchema) => o?.type === "null")) {
      const rest = options.filter((o: JSONSchema) => o?.type !== "null");
      return { schema: rest.length === 1 ? rest[0] : { [key]: rest }, nullable: true };
    }
  }
  return { schema, nullable: false };
}

/** Builds GraphQL types from JSON Schemas, reusing one type for identical shapes. */
class TypeBuilder {
  readonly names = new Set<string>(["JSON", "Query", "Mutation"]);
  readonly outputs = new Map<string, GraphQLObjectType>();
  readonly inputs = new Map<string, GraphQLInputObjectType>();
  readonly enums = new Map<string, GraphQLEnumType>();

  unique(name: string): string {
    let candidate = name;
    for (let i = 2; this.names.has(candidate); i++) candidate = `${name}${i}`;
    this.names.add(candidate);
    return candidate;
  }

  scalar(schema: JSONSchema, name: string): GraphQLOutputType & GraphQLInputType {
    const type = schema.type;
    if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((v: unknown) => typeof v === "string" && NAME.test(v) && !["true", "false", "null"].includes(v))) {
      const key = JSON.stringify(schema.enum);
      let found = this.enums.get(key);
      if (!found) {
        found = new GraphQLEnumType({ name: this.unique(name), values: Object.fromEntries((schema.enum as string[]).map((v) => [v, { value: v }])) });
        this.enums.set(key, found);
      }
      return found;
    }
    const constant = schema.const;
    if (type === "string" || typeof constant === "string" || (Array.isArray(schema.enum) && schema.enum.every((v: unknown) => typeof v === "string"))) return GraphQLString;
    if (type === "integer") return GraphQLInt;
    if (type === "number" || typeof constant === "number") return GraphQLFloat;
    if (type === "boolean" || typeof constant === "boolean") return GraphQLBoolean;
    return GraphQLJSON;
  }

  output(raw: JSONSchema | undefined, name: string): GraphQLOutputType {
    if (!raw || typeof raw !== "object") return GraphQLJSON;
    const { schema, nullable } = nullability(raw);
    const type = this.outputInner(schema, name);
    return nullable ? type : (new GraphQLNonNull(type as never) as GraphQLOutputType);
  }

  private outputInner(schema: JSONSchema, name: string): GraphQLOutputType {
    if (schema.type === "array" && schema.items && typeof schema.items === "object") return new GraphQLList(this.output(schema.items, name));
    if (schema.type === "object" && schema.properties && Object.keys(schema.properties).length && Object.keys(schema.properties).every((k) => NAME.test(k)) && !schema.additionalProperties) {
      const key = JSON.stringify(schema);
      const known = this.outputs.get(key);
      if (known) return known;
      const typeName = this.unique(name);
      const required = new Set<string>(schema.required ?? []);
      const type: GraphQLObjectType = new GraphQLObjectType({
        name: typeName,
        ...(schema.description ? { description: String(schema.description) } : {}),
        fields: () =>
          Object.fromEntries(
            Object.entries(schema.properties as Record<string, JSONSchema>).map(([prop, child]) => {
              let t = this.output(child, typeName + pascal(prop));
              // A field that may be left out of the answer is nullable in GraphQL.
              if (!required.has(prop) && t instanceof GraphQLNonNull) t = t.ofType;
              return [prop, { type: t, ...(child.description ? { description: String(child.description) } : {}) }];
            }),
          ),
      });
      this.outputs.set(key, type);
      return type;
    }
    return this.scalar(schema, name);
  }

  input(raw: JSONSchema, name: string, required: boolean): GraphQLInputType {
    const { schema, nullable } = nullability(raw ?? {});
    const type = this.inputInner(schema, name);
    return required && !nullable && schema.default === undefined ? (new GraphQLNonNull(type as never) as GraphQLInputType) : type;
  }

  private inputInner(schema: JSONSchema, name: string): GraphQLInputType {
    if (schema.type === "array" && schema.items && typeof schema.items === "object") return new GraphQLList(this.input(schema.items, name, true));
    if (schema.type === "object" && schema.properties && Object.keys(schema.properties).length && Object.keys(schema.properties).every((k) => NAME.test(k)) && !schema.additionalProperties) {
      const key = JSON.stringify(schema);
      const known = this.inputs.get(key);
      if (known) return known;
      const typeName = this.unique(name.endsWith("Input") ? name : `${name}Input`);
      const required = new Set<string>(schema.required ?? []);
      const type: GraphQLInputObjectType = new GraphQLInputObjectType({
        name: typeName,
        fields: () =>
          Object.fromEntries(
            Object.entries(schema.properties as Record<string, JSONSchema>).map(([prop, child]) => [prop, { type: this.input(child, typeName.replace(/Input$/, "") + pascal(prop), required.has(prop)) }]),
          ),
      });
      this.inputs.set(key, type);
      return type;
    }
    return this.scalar(schema, name);
  }
}

/** GraphQL arguments as plain values (graphql-js gives objects without a prototype), with nulls for left-out inputs dropped. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v)]));
  return value;
}

function checkFields(kind: "query" | "mutation", fields: unknown): asserts fields is Record<string, RouteDef> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw invalid(`graphqlRoute({ ${kind} }) must be an object of field names to routes.`, `Use graphqlRoute({ query: { notes: listNotes, note: getNote }, mutation: { createNote } }).`);
  }
  for (const [name, def] of Object.entries(fields)) {
    if (!NAME.test(name) || name.startsWith("__")) throw invalid(`"${name}" is not a valid GraphQL field name.`, "Use letters, digits and underscores, starting with a letter: { createNote: createNote }.");
    const r = def as RouteDef;
    if (!r || typeof r !== "object" || r.kind !== "inferlo.route" || typeof r.path !== "string") {
      throw invalid(`The ${kind} field "${name}" is not a route.`, "Map each field to a route made with route.get(...).handle(fn) (or post, put, patch, delete).");
    }
    if (r.method === ("WS" as never)) throw invalid(`The ${kind} field "${name}" is a WebSocket route.`, "Map fields to HTTP routes.");
  }
}

function fieldConfig(name: string, r: RouteDef, types: TypeBuilder, kind: "query" | "mutation"): GraphQLFieldConfig<unknown, FieldContext> {
  const definition = toolDefinition(r);
  const input = definition.inputSchema as JSONSchema;
  const required = new Set<string>(input.required ?? []);
  const args: Record<string, { type: GraphQLInputType; description?: string }> = {};
  for (const [arg, schema] of Object.entries((input.properties ?? {}) as Record<string, JSONSchema>)) {
    if (!NAME.test(arg)) throw invalid(`The ${kind} field "${name}" has the argument "${arg}", which is not a valid GraphQL name.`, "Rename the route's query, params or body field to letters, digits and underscores.");
    args[arg] = { type: types.input(schema, pascal(name) + pascal(arg), required.has(arg)), ...(schema.description ? { description: String(schema.description) } : {}) };
  }
  const o = r.options;
  const response = o.response ? (o.response.toJSONSchema() as JSONSchema) : undefined;
  return {
    type: response ? types.output(response, pascal(name) + "Result") : GraphQLJSON,
    description: o.description ?? o.summary ?? `${r.method} ${r.path}`,
    ...(o.deprecated ? { deprecationReason: typeof o.deprecated === "object" && o.deprecated.sunset ? `Stops working on ${String(o.deprecated.sunset)}.` : "Deprecated." } : {}),
    args,
    resolve: async (_source, values, context) => {
      if (!context || typeof context.run !== "function") {
        throw new GraphQLError("Inferlo GraphQL fields run only through graphqlRoute().", { extensions: { code: "IL6059" } });
      }
      let result: Awaited<ReturnType<FieldContext["run"]>>;
      try {
        result = await context.run(r, plain(values));
      } catch (error) {
        if (error instanceof GraphQLError) throw error;
        // Client errors keep their message; server errors (such as IL5011 for a route that is not registered with the
        // app) only name their code, like other 5xx answers.
        if (error instanceof InferloError && error.status < 500) throw new GraphQLError(error.message, { extensions: { code: error.code, status: error.status } });
        throw new GraphQLError("Internal error.", { extensions: { code: error instanceof InferloError ? error.code : "INTERNAL_SERVER_ERROR", status: 500 } });
      }
      if (result.status >= 400) {
        const out = (result.output && typeof result.output === "object" ? result.output : {}) as { error?: { code?: unknown; message?: unknown; fix?: unknown; details?: unknown } };
        const error = out.error && typeof out.error === "object" ? out.error : {};
        const message = typeof error.message === "string" ? error.message : result.text || `The route answered ${result.status}.`;
        throw new GraphQLError(message, {
          extensions: {
            code: typeof error.code === "string" ? error.code : `HTTP_${result.status}`,
            status: result.status,
            ...(typeof error.fix === "string" ? { fix: error.fix } : {}),
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        });
      }
      return result.status === 204 ? null : result.output;
    },
  };
}

/**
 * The GraphQL schema of graphqlRoute({ query, mutation }), for printing SDL (printSchema from graphql) and client
 * code generation. Its fields run routes only when executed through graphqlRoute().
 */
export function graphqlSchema(options: Pick<GraphQLRouteOptions, "query" | "mutation">): GraphQLSchema {
  if (!options || typeof options !== "object") throw invalid("graphqlRoute() needs options.", "Use graphqlRoute({ query: { notes: listNotes }, mutation: { createNote } }).");
  checkFields("query", options.query);
  if (!Object.keys(options.query).length) throw invalid("graphqlRoute({ query }) needs at least one query field.", "Map a GET route: graphqlRoute({ query: { notes: listNotes } }).");
  if (options.mutation !== undefined) checkFields("mutation", options.mutation);
  const types = new TypeBuilder();
  const build = (kind: "query" | "mutation", fields: Record<string, RouteDef>) => Object.fromEntries(Object.entries(fields).map(([name, r]) => [name, fieldConfig(name, r, types, kind)]));
  const query = new GraphQLObjectType({ name: "Query", fields: build("query", options.query) });
  const mutation = options.mutation && Object.keys(options.mutation).length ? new GraphQLObjectType({ name: "Mutation", fields: build("mutation", options.mutation) }) : undefined;
  const schema = new GraphQLSchema({ query, ...(mutation ? { mutation } : {}) });
  // Build every type now, so a problem shows when the app starts instead of on the first request.
  schema.getTypeMap();
  for (const type of Object.values(schema.getTypeMap())) if (type instanceof GraphQLObjectType || type instanceof GraphQLInputObjectType) type.getFields();
  return schema;
}

/** Top-level fields of an operation, with fragments followed. */
function countRootFields(selectionSet: SelectionSetNode, fragments: Map<string, FragmentDefinitionNode>, seen = new Set<string>()): number {
  let count = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) count += (selection as FieldNode).name.value.startsWith("__") ? 0 : 1;
    else if (selection.kind === Kind.INLINE_FRAGMENT) count += countRootFields(selection.selectionSet, fragments, seen);
    else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (fragment && !seen.has(name)) count += countRootFields(fragment.selectionSet, fragments, new Set([...seen, name]));
    }
  }
  return count;
}

function maxFieldsRule(max: number): ValidationRule {
  return (context: ValidationContext): ASTVisitor => {
    const document: DocumentNode = context.getDocument();
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const d of document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
    return {
      OperationDefinition(node) {
        const count = countRootFields(node.selectionSet, fragments);
        if (count > max) context.reportError(new GraphQLError(`The operation asks for ${count} top-level fields; the most is ${max}.`, { nodes: [node], extensions: { code: "IL2020" } }));
      },
    };
  };
}

/** A GraphQL answer as JSON: data and errors (message, locations, path and extensions). */
function format(result: { data?: unknown; errors?: readonly GraphQLError[] }): { data?: unknown; errors?: unknown[] } {
  const out: { data?: unknown; errors?: unknown[] } = {};
  if (result.errors?.length) {
    out.errors = result.errors.map((e) => ({
      message: e.message,
      ...(e.locations ? { locations: e.locations } : {}),
      ...(e.path ? { path: e.path } : {}),
      ...(e.extensions && Object.keys(e.extensions).length ? { extensions: e.extensions } : {}),
    }));
  }
  if ("data" in result) out.data = plain(result.data);
  return out;
}

/**
 * A POST /graphql route whose query and mutation fields are routes of the app: graphqlRoute({ query: { notes:
 * listNotes }, mutation: { createNote } }). Register it with the app's routes. Each field runs its route as the
 * caller, with that route's auth, permissions, validation and rate limits.
 */
export function graphqlRoute(options: GraphQLRouteOptions): RouteDef {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw invalid("graphqlRoute() needs options.", "Use graphqlRoute({ query: { notes: listNotes }, mutation: { createNote } }).");
  const known = ["query", "mutation", "path", "auth", "rateLimit", "introspection", "maxFields"];
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) throw invalid(`Unknown graphqlRoute() option "${key}".`, `Options: ${known.join(", ")}.`);
  }
  const path = options.path ?? "/graphql";
  if (typeof path !== "string" || !path.startsWith("/") || path.includes(":")) throw invalid(`graphqlRoute({ path }) must be a fixed path starting with "/", got ${JSON.stringify(path)}.`, 'Use path: "/graphql".');
  const maxFields = options.maxFields ?? 20;
  if (!Number.isSafeInteger(maxFields) || maxFields < 1) throw invalid(`graphqlRoute({ maxFields }) must be a whole number above 0, got ${String(options.maxFields)}.`, "Use maxFields: 20.");
  if (options.introspection !== undefined && typeof options.introspection !== "boolean") throw invalid("graphqlRoute({ introspection }) must be true or false.", "Use introspection: false to hide the schema.");
  const schema = graphqlSchema(options);
  const rules = [...specifiedRules, maxFieldsRule(maxFields), ...(options.introspection === false ? [NoSchemaIntrospectionCustomRule] : [])];
  const body = t.object({
    query: t.string().max(100_000).describe("The GraphQL document"),
    variables: t.json<Record<string, unknown>>().optional().describe("Values of the operation's variables"),
    operationName: t.string().max(1000).optional().describe("Which operation of the document to run"),
  });
  return route.post(path, { auth: options.auth ?? "user", body, ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}), summary: "GraphQL endpoint", tags: ["graphql"] }).handle(async ({ body, ai, signal }) => {
    let document: DocumentNode;
    try {
      document = parse(body.query, { maxTokens: 10_000 });
    } catch (error) {
      if (error instanceof GraphQLError) return format({ errors: [error] });
      throw error;
    }
    const errors = validate(schema, document, rules);
    if (errors.length) return format({ errors });
    const variables = body.variables ?? undefined;
    if (variables !== undefined && (variables === null || typeof variables !== "object" || Array.isArray(variables))) {
      return format({ errors: [new GraphQLError("variables must be an object.", { extensions: { code: "IL1001" } })] });
    }
    const tools = routeToolsOf(ai);
    const context: FieldContext = {
      run: (r, input) => {
        if (!tools) throw new GraphQLError("GraphQL fields need the request's context.", { extensions: { code: "IL6059" } });
        if (signal.aborted) throw new GraphQLError("The request was cancelled.", { extensions: { code: "IL2007" } });
        return tools.runner(r, input);
      },
    };
    return format(await execute({ schema, document, variableValues: variables, operationName: body.operationName, contextValue: context }));
  });
}
