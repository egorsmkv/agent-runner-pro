import YAML from 'yaml';

export function parseHumanInputRequest(text) {
  for (const candidate of yamlCandidates(text)) {
    let parsed;

    try {
      parsed = YAML.parse(candidate);
    } catch {
      continue;
    }

    const request = parsed?.ask_human;
    if (!request || typeof request !== 'object') {
      continue;
    }

    const question = normalizeString(request.question);
    if (!question) {
      continue;
    }

    return {
      question,
      recommendation: normalizeString(request.recommendation),
      blockingReason: normalizeString(request.blockingReason),
      defaultOptionId: normalizeString(request.defaultOptionId),
      options: normalizeOptions(request.options),
    };
  }

  return null;
}

export function humanInputBlockerSummary(request) {
  const parts = [`Human input required: ${request.question}`];

  if (request.recommendation) {
    parts.push(`Recommendation: ${request.recommendation}`);
  }

  if (request.defaultOptionId) {
    parts.push(`Default option: ${request.defaultOptionId}`);
  }

  if (request.blockingReason) {
    parts.push(`Blocking reason: ${request.blockingReason}`);
  }

  if (request.options.length > 0) {
    parts.push(
      `Options: ${request.options
        .map((option) =>
          [option.id, option.label, option.tradeoff ? `(${option.tradeoff})` : '']
            .filter(Boolean)
            .join(' '),
        )
        .join('; ')}`,
    );
  }

  return parts.join(' ');
}

function yamlCandidates(text) {
  const source = String(text ?? '');
  const candidates = [];
  const fencePattern = /```(?:ya?ml)?\s*([\s\S]*?)```/gi;
  let match;

  while ((match = fencePattern.exec(source))) {
    candidates.push(match[1]);
  }

  candidates.push(source);
  return candidates;
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: normalizeString(item.id),
      label: normalizeString(item.label),
      tradeoff: normalizeString(item.tradeoff),
    }))
    .filter((item) => item.id || item.label || item.tradeoff);
}

function normalizeString(value) {
  return String(value ?? '').trim();
}
