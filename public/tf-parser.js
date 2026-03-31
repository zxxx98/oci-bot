function extractBlock(content, blockName) {
  const blockPattern = new RegExp(`${blockName}\\s*\\{`, "m");
  const match = blockPattern.exec(content);
  if (!match) {
    return "";
  }

  let depth = 0;
  let started = false;
  let index = match.index + match[0].length - 1;

  for (; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      depth += 1;
      started = true;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (started && depth === 0) {
        return content.slice(match.index, index + 1);
      }
    }
  }

  return content.slice(match.index);
}

function extractString(content, pattern) {
  const match = content.match(pattern);
  return match?.[1];
}

function extractNumber(content, pattern) {
  const value = extractString(content, pattern);
  if (value == null) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseTerraformBotConfig(content) {
  const instanceBlock = extractBlock(content, 'resource\\s+"oci_core_instance"\\s+"[^"]+"');
  if (!instanceBlock) {
    return {};
  }

  const createVnicBlock = extractBlock(instanceBlock, "create_vnic_details");
  const sourceDetailsBlock = extractBlock(instanceBlock, "source_details");
  const shapeConfigBlock = extractBlock(instanceBlock, "shape_config");

  return {
    subnetId: extractString(createVnicBlock, /subnet_id\s*=\s*"([^"]+)"/),
    compartmentId: extractString(instanceBlock, /compartment_id\s*=\s*"([^"]+)"/),
    availabilityDomain: extractString(instanceBlock, /availability_domain\s*=\s*"([^"]+)"/),
    imageId: extractString(sourceDetailsBlock, /source_id\s*=\s*"([^"]+)"/),
    displayName: extractString(instanceBlock, /display_name\s*=\s*"([^"]+)"/),
    sshAuthorizedKeys: extractString(instanceBlock, /"ssh_authorized_keys"\s*=\s*"([^"]+)"/),
    ocpus: extractNumber(shapeConfigBlock, /ocpus\s*=\s*"([^"]+)"/),
    memory: extractNumber(shapeConfigBlock, /memory_in_gbs\s*=\s*"([^"]+)"/),
  };
}
