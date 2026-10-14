import postcss, { type ChildNode, type Node } from 'postcss'
import selectorParser from 'postcss-selector-parser'

const hasAncestor = (node: ChildNode, predicate: (ancestor: Node & { name?: string }) => boolean) => {
  let parent: Node | undefined = node.parent
  while (parent && parent.type !== 'root' && parent.type !== 'document') {
    if (predicate(parent)) return true
    parent = parent.parent
  }
  return false
}

/**
 * Use ordinary selectors: WebKitGTK can ignore native @scope rules on form
 * controls. The zero-specificity prefix preserves plugin selector precedence;
 * the target guard also confines :scope and nested sibling combinators.
 * Namespaced global definitions validated by the plugin SDK remain unchanged.
 */
export const isolatePluginStyles = (source: string, roots: readonly string[]): string => {
  if (!roots.length) return ''
  if (roots.some(root => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(root))) {
    throw new Error('Invalid trusted plugin stylesheet root')
  }
  const rootSelector = `:where(${roots.join(', ')})`
  const boundary = `:where(${roots.flatMap(root => [root, `${root} *`]).join(', ')})`
  const parseNode = (selector: string) => selectorParser().astSync(selector).first!.first!.clone()
  const css = postcss.parse(source)
  css.walkAtRules(rule => {
    // These rules were invalid inside the old @scope wrapper. Promoting them
    // to stylesheet level would load unprocessed CSS or affect host-wide state.
    if (['import', 'namespace', 'page', 'document', '-moz-document'].includes(rule.name.toLowerCase())) {
      throw new Error(`Unsupported global plugin CSS rule @${rule.name}`)
    }
  })
  css.walkRules(rule => {
    if (hasAncestor(rule, ancestor => ancestor.type === 'atrule' && /^(?:-webkit-)?keyframes$/i.test(ancestor.name ?? ''))) return
    const nested = hasAncestor(rule, ancestor => ancestor.type === 'rule')
    const explicitScope = hasAncestor(rule, ancestor => ancestor.type === 'atrule' && ancestor.name?.toLowerCase() === 'scope')
    rule.selector = selectorParser(selectors => {
      selectors.each(selector => {
        const scopeNodes: selectorParser.Pseudo[] = []
        if (!explicitScope) selector.walkPseudos(pseudo => {
          if (pseudo.value === ':scope') scopeNodes.push(pseudo)
        })
        scopeNodes.forEach(pseudo => pseudo.replaceWith(parseNode(rootSelector)))
        // A pseudo-element must remain after the subject's final compound.
        const pseudoElement = selector.nodes.find(node => node.type === 'pseudo' &&
          (node.value.startsWith('::') || /^:(before|after|first-line|first-letter)$/i.test(node.value)))
        if (nested || scopeNodes.length) {
          if (pseudoElement) selector.insertBefore(pseudoElement, parseNode(boundary))
          else selector.append(parseNode(boundary))
        }
        if (!nested && !scopeNodes.length) {
          selector.prepend(selectorParser.combinator({ value: ' ' }))
          selector.prepend(parseNode(rootSelector))
        }
      })
    }).processSync(rule.selector)
  })
  return css.toString()
}
