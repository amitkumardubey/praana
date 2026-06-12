import type { ContextArtifact, SessionCheckpoint, TurnDigest, TurnRecord } from "./types.js";

export interface RelatedArtifactRef {
  id: string;
  label: string;
  turn: number;
}

export interface EventLineage {
  artifactId: string;
  sourceTool: string;
  command?: string;
  contentType: string;
  producedTurn: number;
  producedBy: string;
  relatedDecisions: string[];
  relatedArtifacts: RelatedArtifactRef[];
  relatedFiles: string[];
}

export function buildEventLineage(input: {
  artifact: ContextArtifact;
  turnRecord: TurnRecord | null;
  turnDigest: TurnDigest | null;
  checkpoint: SessionCheckpoint | null;
  sessionArtifacts: ContextArtifact[];
  turnRecords: TurnRecord[];
}): EventLineage {
  const { artifact, turnRecord, turnDigest, checkpoint, sessionArtifacts, turnRecords } =
    input;
  const producedTurn = artifact.createdTurn;

  const producedBy = describeProducer(artifact, turnRecord);
  const relatedFiles = collectRelatedFiles(turnRecord, turnDigest);
  const relatedDecisions = collectRelatedDecisions(
    turnDigest,
    checkpoint,
    producedTurn,
  );
  const relatedArtifacts = collectRelatedArtifacts(
    artifact,
    sessionArtifacts,
    turnRecords,
    relatedFiles,
  );

  return {
    artifactId: artifact.id,
    sourceTool: artifact.sourceTool,
    command: artifact.command,
    contentType: artifact.contentType,
    producedTurn,
    producedBy,
    relatedDecisions,
    relatedArtifacts,
    relatedFiles,
  };
}

function describeProducer(
  artifact: ContextArtifact,
  turnRecord: TurnRecord | null,
): string {
  if (turnRecord) {
    const toolCall = turnRecord.toolCalls.find(
      (tc) => tc.resultArtifactId === artifact.id,
    );
    if (toolCall) {
      const command =
        typeof toolCall.args.command === "string"
          ? toolCall.args.command
          : typeof toolCall.args.path === "string"
            ? toolCall.args.path
            : undefined;
      if (command) {
        return `${toolCall.tool} command "${command}" in turn ${turnRecord.turn}`;
      }
      return `${toolCall.tool} in turn ${turnRecord.turn}`;
    }
  }

  if (artifact.command) {
    return `${artifact.sourceTool} command "${artifact.command}" in turn ${artifact.createdTurn}`;
  }
  return `${artifact.sourceTool} in turn ${artifact.createdTurn}`;
}

function collectRelatedFiles(
  turnRecord: TurnRecord | null,
  turnDigest: TurnDigest | null,
): string[] {
  const files = new Set<string>();
  for (const path of turnRecord?.filesRead ?? []) files.add(path);
  for (const path of turnRecord?.filesWritten ?? []) files.add(path);
  for (const path of turnDigest?.filesChanged ?? []) files.add(path);
  return [...files];
}

function collectRelatedDecisions(
  turnDigest: TurnDigest | null,
  checkpoint: SessionCheckpoint | null,
  producedTurn: number,
): string[] {
  const decisions = new Set<string>();
  for (const decision of turnDigest?.decisions ?? []) {
    decisions.add(typeof decision === "string" ? decision : decision.summary);
  }
  for (const decision of checkpoint?.state.decisions ?? []) {
    if (decision.turn <= producedTurn) {
      decisions.add(decision.summary);
    }
  }
  return [...decisions].slice(-10);
}

function collectRelatedArtifacts(
  artifact: ContextArtifact,
  sessionArtifacts: ContextArtifact[],
  turnRecords: TurnRecord[],
  relatedFiles: string[],
): RelatedArtifactRef[] {
  const refs: RelatedArtifactRef[] = [];
  const seen = new Set<string>([artifact.id]);
  const fileSet = new Set(relatedFiles);

  const add = (item: ContextArtifact) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    const label = item.command
      ? `${item.sourceTool}: ${item.command}`
      : item.sourceTool;
    refs.push({ id: item.id, label, turn: item.createdTurn });
  };

  for (const other of sessionArtifacts) {
    if (other.createdTurn === artifact.createdTurn) {
      add(other);
    }
  }

  for (const delta of [-1, 1]) {
    const neighborTurn = artifact.createdTurn + delta;
    for (const other of sessionArtifacts) {
      if (other.createdTurn !== neighborTurn) continue;
      add(other);
    }
  }

  if (fileSet.size > 0) {
    for (const record of turnRecords) {
      const recordFiles = [...record.filesRead, ...record.filesWritten];
      if (!recordFiles.some((path) => fileSet.has(path))) continue;
      for (const artifactId of record.artifactIds) {
        const match = sessionArtifacts.find((a) => a.id === artifactId);
        if (match) add(match);
      }
    }
  }

  return refs.sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id));
}

export function formatEventLineage(lineage: EventLineage): string {
  const header = lineage.command
    ? `${lineage.artifactId} (${lineage.command}, turn ${lineage.producedTurn})`
    : `${lineage.artifactId} (${lineage.sourceTool}, turn ${lineage.producedTurn})`;

  const lines = [
    `Artifact ${header}`,
    `Produced by: ${lineage.producedBy}`,
  ];

  if (lineage.relatedDecisions.length > 0) {
    lines.push(
      `Related decisions: ${lineage.relatedDecisions.join(", ")}`,
    );
  }

  if (lineage.relatedArtifacts.length > 0) {
    lines.push(
      "Related artifacts:",
      ...lineage.relatedArtifacts.map(
        (ref) => `- ${ref.id} (${ref.label}, turn ${ref.turn})`,
      ),
    );
  }

  if (lineage.relatedFiles.length > 0) {
    lines.push(`Related files: ${lineage.relatedFiles.join(", ")}`);
  }

  return lines.join("\n");
}
