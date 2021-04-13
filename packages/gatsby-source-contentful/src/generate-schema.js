const fs = require(`fs`)
const { cloneDeep } = require(`lodash`)

import { makeTypeName } from "./normalize"

const types = []

function generateAssetTypes({ createTypes }) {
  createTypes(`
    type ContentfulAsset implements ContentfulInternalReference & Node {
      file: ContentfulAssetFile
      title: String
      description: String
      node_locale: String
      sys: ContentfulAssetSys
      contentful_id: String!
      id: ID!
      spaceId: String!
      createdAt: String! # Date @dateform,
      updatedAt: String! # Date @dateform,
    }
  `)

  createTypes(`
    type ContentfulAssetFile @derivedTypes {
      url: String
      details: ContentfulAssetFileDetails
      fileName: String
      contentType: String
    }
  `)

  createTypes(`
    type ContentfulAssetFileDetails @derivedTypes {
      size: Int
      image: ContentfulAssetFileDetailsImage
    }
  `)

  createTypes(`
    type ContentfulAssetFileDetailsImage {
      width: Int
      height: Int
    }
  `)

  createTypes(`
    type ContentfulAssetSys {
      type: String
      revision: Int
    }
  `)
}

export function generateSchema({
  createTypes,
  schema,
  pluginConfig,
  contentTypeItems,
}) {
  // logger @todo remove it
  const origTypes = createTypes
  createTypes = (...all) => {
    types.push(all)
    origTypes(...all)
  }

  createTypes(`
    interface ContentfulInternalReference implements Node {
      contentful_id: String!
      id: ID!
    }
  `)

  createTypes(`
    type ContentfulContentType implements Node {
      id: ID!
      name: String!
      displayField: String!
      description: String!
    }
  `)

  createTypes(`
    type ContentfulInternalSys @dontInfer {
      type: String
      revision: Int
      contentType: ContentfulContentType @link(by: "id", from: "contentType___NODE")
    }
  `)

  createTypes(`
    interface ContentfulEntry implements Node @dontInfer {
      contentful_id: String!
      id: ID!
      spaceId: String!
      sys: ContentfulInternalSys
    }
  `)

  generateAssetTypes({ createTypes })

  // Contentful specific types
  createTypes(
    schema.buildObjectType({
      name: `ContentfulNodeTypeRichText`,
      fields: {
        raw: {
          type: `JSON`,
          resolve(source) {
            return source
          },
        },
        references: {
          type: `[ContentfulInternalReference]`,
          resolve(source, args, context) {
            const referencedEntries = new Set()
            const referencedAssets = new Set()

            // Locate all Contentful Links within the rich text data
            // Traverse logic based on https://github.com/contentful/contentful-resolve-response
            const traverse = obj => {
              // eslint-disable-next-line guard-for-in
              for (const k in obj) {
                const v = obj[k]
                if (v && v.sys && v.sys.type === `Link`) {
                  if (v.sys.linkType === `Asset`) {
                    console.log(`adding asset`, v)
                    referencedAssets.add(v.sys.id)
                  }
                  if (v.sys.linkType === `Entry`) {
                    console.log(`adding entry`, v)
                    referencedEntries.add(v.sys.id)
                  }
                } else if (v && typeof v === `object`) {
                  traverse(v)
                }
              }
            }
            traverse(source)

            return context.nodeModel
              .getAllNodes()
              .filter(node =>
                node.internal.owner === `gatsby-source-contentful` &&
                node.internal.type === `ContentfulAsset`
                  ? referencedAssets.has(node.contentful_id)
                  : referencedEntries.has(node.contentful_id)
              )
          },
        },
      },
      extensions: { dontInfer: {} },
    })
  )

  createTypes(
    schema.buildObjectType({
      name: `ContentfulNodeTypeLocation`,
      fields: {
        lat: { type: `Float!` },
        lon: { type: `Float!` },
      },
      extensions: {
        dontInfer: {},
      },
    })
  )

  // Is there a way to have this as string and let transformer-remark replace it with an object?
  createTypes(
    schema.buildObjectType({
      name: `ContentfulNodeTypeText`,
      fields: {
        raw: `String!`,
      },
      interfaces: [`Node`],
      extensions: {
        dontInfer: {},
      },
    })
  )

  // Contentful content type schemas
  const ContentfulDataTypes = new Map([
    [`Symbol`, `String`],
    [
      `Text`,
      {
        type: `ContentfulNodeTypeText`,
        extensions: {
          link: { by: `id` },
        },
      },
    ],
    [`Integer`, `Int`],
    [`Number`, `Float`],
    [
      `Date`,
      {
        type: `Date`,
        extensions: {
          dateformat: {},
        },
      },
    ],
    [`Object`, `JSON`],
    [`Boolean`, `Boolean`],
    [`Location`, `ContentfulNodeTypeLocation`],
    [`RichText`, `ContentfulNodeTypeRichText`],
  ])

  const getLinkFieldType = linkType => {
    return {
      type: `Contentful${linkType}`,
      extensions: {
        link: { by: `id` },
      },
    }
  }

  const translateFieldType = field => {
    let id
    if (field.type === `Array`) {
      const fieldData =
        field.items.type === `Link`
          ? getLinkFieldType(field.items.linkType)
          : translateFieldType(field.items)

      id =
        typeof fieldData === `string`
          ? `[${fieldData}]`
          : { ...fieldData, type: `[${fieldData.type}]` }
    } else if (field.type === `Link`) {
      id = getLinkFieldType(field.linkType)
    } else {
      id = ContentfulDataTypes.get(field.type)
    }

    if (typeof id === `string`) {
      return [id, field.required && `!`].filter(Boolean).join(``)
    }

    id = cloneDeep(id)

    if (field.required) {
      id.type = `${id.type}!`
    }

    if (id?.extensions?.link) {
      id.extensions.link.from = `${field.id}___NODE`
    }

    return id
  }

  for (const contentTypeItem of contentTypeItems) {
    try {
      const fields = {}
      contentTypeItem.fields.forEach(field => {
        if (field.disabled || field.omitted) {
          return
        }
        const type = translateFieldType(field)
        fields[field.id] = typeof type === `string` ? { type } : type
      })

      const type = pluginConfig.get(`useNameForId`)
        ? contentTypeItem.name
        : contentTypeItem.sys.id

      createTypes(
        schema.buildObjectType({
          name: makeTypeName(type),
          fields: {
            contentful_id: { type: `String!` },
            id: { type: `ID!` },
            // @todo reconsider the node per locale workflow
            node_locale: { type: `String!` },
            // @todo these should be real dates and in sys
            spaceId: { type: `String!` },
            createdAt: { type: `String!` }, // { type: `Date`, extensions: { dateform: {} } },
            updatedAt: { type: `String!` }, // { type: `Date`, extensions: { dateform: {} } },
            // @todo add metadata
            sys: { type: `ContentfulInternalSys` },
            ...fields,
          },
          interfaces: [
            `ContentfulInternalReference`,
            `ContentfulEntry`,
            `Node`,
          ],
        })
      )
    } catch (err) {
      err.message = `Unable to create schema for Contentful Content Type ${
        contentTypeItem.name || contentTypeItem.sys.id
      }:\n${err.message}`
      throw err
    }
  }

  fs.writeFileSync(
    process.cwd() + `/generated-types.json`,
    JSON.stringify(types, null, 2)
  )
  createTypes = origTypes
}