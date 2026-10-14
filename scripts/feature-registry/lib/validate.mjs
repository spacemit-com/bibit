import Ajv from 'ajv'

const formatAjvErrors = (errors) =>
  (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ')

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

const contributionKey = (featureId, contributionId) =>
  `${featureId}:${contributionId}`

const finalUrl = (kind, featureId, path) => {
  const base = kind === 'pages' ? `/features/${featureId}` : `/settings/features/${featureId}`
  return path ? `${base}/${path}` : base
}

const pathsOverlap = (left, right) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)

function validateContributionIds(feature) {
  const seen = new Set()
  for (const contribution of [
    ...feature.manifest.contributions.pages,
    ...feature.manifest.contributions.settings,
    ...feature.manifest.contributions.conversation,
  ]) {
    const key = contributionKey(feature.manifest.id, contribution.id)
    if (seen.has(key)) {
      throw new Error(`duplicate contribution id in ${feature.manifest.id}: ${contribution.id}`)
    }
    seen.add(key)
  }
}

function validateUrls(features) {
  const routed = []
  for (const feature of features) {
    for (const kind of ['pages', 'settings']) {
      for (const contribution of feature.manifest.contributions[kind]) {
        for (const surface of contribution.surfaces) {
          routed.push({
            featureId: feature.manifest.id,
            contributionId: contribution.id,
            kind,
            surface,
            url: finalUrl(kind, feature.manifest.id, contribution.path),
          })
        }
      }
    }
  }

  for (let leftIndex = 0; leftIndex < routed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < routed.length; rightIndex += 1) {
      const left = routed[leftIndex]
      const right = routed[rightIndex]
      if (left.kind !== right.kind || left.surface !== right.surface) continue
      if (left.url === right.url) {
        throw new Error(
          `duplicate final URL on ${left.surface}: ${left.url} (${left.featureId}:${left.contributionId}, ${right.featureId}:${right.contributionId})`
        )
      }
      if (pathsOverlap(left.url, right.url)) {
        throw new Error(
          `overlapping final URLs on ${left.surface}: ${left.url} and ${right.url}`
        )
      }
    }
  }
}

function validatePermissionPresenter(features) {
  const presenters = new Map()
  for (const feature of features) {
    for (const contribution of feature.manifest.contributions.conversation) {
      if (contribution.kind !== 'permission-presenter') continue
      for (const surface of contribution.surfaces) {
        const previous = presenters.get(surface)
        if (previous) {
          throw new Error(
            `permission-presenter on ${surface} is exclusive: ${previous} conflicts with ${feature.manifest.id}:${contribution.id}`
          )
        }
        presenters.set(surface, `${feature.manifest.id}:${contribution.id}`)
      }
    }
  }
}

function validateGrants(features, grants, validateCapability) {
  if (
    !grants ||
    grants.version !== 1 ||
    !grants.features ||
    typeof grants.features !== 'object' ||
    Array.isArray(grants.features)
  ) {
    throw new Error('feature-capability-grants.json must contain version 1 and a features object')
  }
  const grantKeys = Object.keys(grants).sort()
  if (grantKeys.some((key) => !['features', 'serviceOperations', 'version'].includes(key))) {
    throw new Error('feature-capability-grants.json contains unknown fields')
  }

  for (const [featureId, capabilities] of Object.entries(grants.features)) {
    if (!Array.isArray(capabilities) || new Set(capabilities).size !== capabilities.length) {
      throw new Error(`capability grants for ${featureId} must be a unique array`)
    }
    for (const capability of capabilities) {
      if (!validateCapability(capability)) {
        throw new Error(`capability grants for ${featureId} contain unknown capability: ${capability}`)
      }
    }
  }

  for (const [featureId, services] of Object.entries(grants.serviceOperations ?? {})) {
    if (!services || typeof services !== 'object' || Array.isArray(services)) {
      throw new Error(`service operation grants for ${featureId} must be an object`)
    }
    const capabilities = new Set(grants.features[featureId] ?? [])
    for (const [serviceId, operations] of Object.entries(services)) {
      if (serviceId.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(serviceId)) {
        throw new Error(`service operation grants for ${featureId} contain invalid service: ${serviceId}`)
      }
      if (!Array.isArray(operations) || new Set(operations).size !== operations.length) {
        throw new Error(`service operation grants for ${featureId}/${serviceId} must be a unique array`)
      }
      if (!capabilities.has(`service:${serviceId}`) && !capabilities.has(`external-service:${serviceId}`)) {
        throw new Error(`service operation grants for ${featureId}/${serviceId} require a matching capability grant`)
      }
      if (operations.some((operation) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation) || !operation.includes('.'))) {
        throw new Error(`service operation grants for ${featureId}/${serviceId} contain an invalid operation`)
      }
    }
  }

  for (const feature of features) {
    const granted = new Set(grants.features[feature.manifest.id] ?? [])
    for (const capability of feature.manifest.requiredHostCapabilities) {
      if (!granted.has(capability)) {
        throw new Error(
          `${feature.manifest.id} is not granted required capability ${capability}`
        )
      }
    }
  }
}

export function validateFeatures(features, schema, grants) {
  const ajv = new Ajv({ allErrors: true, strict: true })
  const validateSchema = ajv.compile(schema)
  const validateCapability = ajv.compile(schema.$defs.hostCapability)
  for (const feature of features) {
    if (!validateSchema(feature.manifest)) {
      throw new Error(
        `${feature.packageName} schema validation failed: ${formatAjvErrors(validateSchema.errors)}`
      )
    }
    const expectedPackageName = `@bibit/feature-${feature.manifest.id}`
    if (feature.packageName !== expectedPackageName) {
      throw new Error(
        `${feature.packageName} does not match Manifest id ${feature.manifest.id}; expected ${expectedPackageName}`
      )
    }
    validateContributionIds(feature)
  }

  const seenFeatureIds = new Set()
  for (const feature of features) {
    if (seenFeatureIds.has(feature.manifest.id)) {
      throw new Error(`duplicate Feature id: ${feature.manifest.id}`)
    }
    seenFeatureIds.add(feature.manifest.id)
  }

  validateGrants(features, grants, validateCapability)
  validateUrls(features)
  validatePermissionPresenter(features)

  return [...features].sort(
    (left, right) =>
      compareText(left.manifest.id, right.manifest.id) ||
      compareText(left.packageName, right.packageName)
  )
}
