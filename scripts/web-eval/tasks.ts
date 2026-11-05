import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
const url = z.url().refine(value => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
});
const nonempty = z.string().trim().min(1);
const domain = z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i);

export const searchTaskSchema = z.strictObject({
  query: nonempty,
  authoritative_url: url,
  expected_domains: z.array(domain).min(1),
  answer_snippets: z.array(nonempty).min(1).max(3),
  niche: z.enum(["docs", "error", "release", "version-change"]),
  verified_at: date,
});
export const fetchTaskSchema = z.strictObject({
  url,
  probe: nonempty,
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  verified_at: date,
});
export type SearchTask = z.infer<typeof searchTaskSchema>;
export type FetchTask = z.infer<typeof fetchTaskSchema>;

export function validateTasks(kind: "search" | "fetch", input: unknown): string[] {
  const schema = kind === "search" ? z.array(searchTaskSchema) : z.array(fetchTaskSchema);
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`);
}

export function verifyTask(task: SearchTask | FetchTask, text: string): string[] {
  const expected = "answer_snippets" in task ? task.answer_snippets : [task.probe];
  const normalized = text.toLocaleLowerCase("en-US");
  return expected.filter(snippet => !normalized.includes(snippet.toLocaleLowerCase("en-US")));
}
