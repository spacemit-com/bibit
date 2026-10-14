/**
 * Determines if the given path is a root directory.
 *
 * Checks whether the path is a Linux root directory.
 *
 * @param selectedNewPath - The path to check.
 * @returns `true` if the path is a root directory, otherwise `false`.
 */
export const isRootDir = (selectedNewPath: string) => {
  // Linux root: /, /mnt, /media, etc.
  const linuxRoots = [
    '/',
    '/mnt',
    '/media',
    '/boot',
    '/home',
    '/opt',
    '/var',
    '/usr',
  ]
  const normalized =
    selectedNewPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return linuxRoots.some((root) => normalized === root)
}
