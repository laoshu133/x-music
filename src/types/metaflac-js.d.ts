declare module 'metaflac-js' {
  export default class Metaflac {
    constructor(file: string | Buffer)
    pictures: Buffer[]
    picturesSpecs: unknown[]
    picturesDatas: Buffer[]
    removeTag(name: string): void
    setTag(field: string): void
    importPictureFromBuffer(picture: Buffer): void
    save(): Buffer | void
  }
}
