import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";
import type { FlexStatementEvidence } from "./types.js";

/** A bound on both HTTP bytes and direct parser input. */
export const FLEX_MAX_BYTES = 8 * 1024 * 1024;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  attributesGroupName: "$",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  maxNestedTags: 32,
});

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Flex document structure");
  }
  return value as Record<string, unknown>;
}

/** Never include the XML parser's diagnostic: it can contain private source data. */
export function parseFlexDocument(xml: string): Record<string, unknown> {
  if (Buffer.byteLength(xml, "utf8") > FLEX_MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("Flex XML exceeds safe input limits");
  }
  try {
    SyntaxValidator.validate(xml, {
      invalidCharSequence: { comment: true, tagValue: true, attrLt: true },
    });
    const parsed: unknown = parser.parse(xml);
    return object(parsed);
  } catch {
    throw new Error("Malformed Flex XML");
  }
}

function attributes(node: Record<string, unknown>): Readonly<Record<string, string>> {
  const raw = node["$"] === undefined ? {} : object(node["$"]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error("Malformed Flex attributes");
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}

function onlyChildren(node: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(node)) {
    if (key === "$" || allowed.includes(key)) continue;
    if (key === "#text" && typeof node[key] === "string" && node[key].trim() === "") continue;
    throw new Error("Unexpected Flex document content");
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function checkCount(node: Record<string, unknown>, count: number, required: boolean): void {
  const stated = attributes(node)["count"];
  if (stated === undefined && !required) return;
  if (stated === undefined || !/^\d+$/.test(stated) || Number(stated) !== count) {
    throw new Error("Flex document count mismatch");
  }
}

function section(
  statement: Record<string, unknown>,
  name: string,
  rowName: string
): readonly Readonly<Record<string, string>>[] | null {
  const raw = statement[name];
  if (raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return [];
  const node = object(raw);
  onlyChildren(node, [rowName]);
  const rows = node[rowName] === undefined ? [] : list(node[rowName]);
  checkCount(node, rows.length, false);
  return rows.map((row) => {
    const fields = object(row);
    onlyChildren(fields, []);
    return attributes(fields);
  });
}

export function flexStatementsOf(
  document: Record<string, unknown>
): readonly FlexStatementEvidence[] {
  onlyChildren(document, ["FlexQueryResponse"]);
  const response = object(document["FlexQueryResponse"]);
  onlyChildren(response, ["FlexStatements"]);
  const container = object(response["FlexStatements"]);
  onlyChildren(container, ["FlexStatement"]);
  const statements =
    container["FlexStatement"] === undefined ? [] : list(container["FlexStatement"]);
  checkCount(container, statements.length, true);
  return statements.map((raw) => {
    const statement = object(raw);
    return {
      statementAttributes: attributes(statement),
      cashTransactions: section(statement, "CashTransactions", "CashTransaction"),
      transfers: section(statement, "Transfers", "Transfer"),
    };
  });
}

/** Parse cash and transfer sections, not an assertion that a query is unfiltered. */
export function parseFlexStatement(xml: string): readonly FlexStatementEvidence[] {
  return flexStatementsOf(parseFlexDocument(xml));
}
