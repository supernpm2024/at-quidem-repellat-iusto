import { fetchLines } from "./fetch-lines"

const DB_URL =
    "https://unicode.org/Public/UCD/latest/ucd/PropertyValueAliases.txt"
const logger = console
export type UnicodePropertyValue = {
    propertyAlias: string
    aliases: string[]
    canonical: string
}
let cache: UnicodePropertyValue[] | undefined = undefined
export async function* getLatestUnicodePropertyValues(): AsyncIterable<UnicodePropertyValue> {
    logger.log("Fetching data... (%s)", DB_URL)
    const iterable = cache
        ? cache
        : (async function* () {
              const newCache: UnicodePropertyValue[] = []
              for await (const line of fetchLines(DB_URL)) {
                  if (!line || line.startsWith("#")) {
                      continue
                  }
                  const [propertyAlias, alias, canonical, ...remaining] = line
                      .split("#")[0] // strip comments
                      .split(";") // split by semicolon
                      .map((x) => x.trim()) // trim

                  const value: UnicodePropertyValue = {
                      propertyAlias,
                      aliases: [canonical, alias, ...remaining],
                      canonical,
                  }
                  newCache.push(value)
                  yield value
              }
              cache = newCache
          })()
    for await (const value of iterable) {
        yield value
    }
}
