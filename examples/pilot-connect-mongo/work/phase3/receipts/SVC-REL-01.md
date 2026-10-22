receipt: 354865edab2e
# Evidence receipt: SVC-REL-01

title: A start-up connect or createIndex failure is stored for good in collectionP: the store never retries and every session operation fails until the process restarts
source: new
date: 2026-10-22
pins: connect-mongo@182cfb09ad8a758183f1e2f4ef9867bac4651900

## Command 1 of 4

command:
```
git -C {repo:connect-mongo} show {pin:connect-mongo}:src/lib/MongoStore.ts | sed -n 225,245p
```
expect: collectionP is assigned once as _clientP.then(async ...) with `await this.setAutoRemove(collection)`; no .catch, retry or reset follows
classification: ran
exit code: 0
output (21 lines):
```
    let _clientP: Promise<MongoClient>
    if (options.mongoUrl) {
      _clientP = MongoClient.connect(options.mongoUrl, options.mongoOptions)
    } else if (options.clientPromise) {
      _clientP = options.clientPromise
    } else if (options.client) {
      _clientP = Promise.resolve(options.client)
    } else {
      throw new Error('Cannot init client. Please provide correct options')
    }
    assert(!!_clientP, 'Client is null|undefined')
    this.clientP = _clientP
    this.options = options
    this.collectionP = _clientP.then(async (con) => {
      const collection = con
        .db(options.dbName)
        .collection<InternalSessionType<T>>(options.collectionName)
      await this.setAutoRemove(collection)
      return collection
    })
  }
```

## Command 2 of 4

command:
```
git -C {repo:connect-mongo} show {pin:connect-mongo}:src/lib/MongoStore.ts | sed -n 261,270p
```
expect: the 'native' case returns collection.createIndex({ expires: 1 }, { background: true, expireAfterSeconds: 0 }) with no error handling
classification: ran
exit code: 0
output (10 lines):
```
    switch (this.options.autoRemove) {
      case 'native':
        debug('Creating MongoDB TTL index')
        return collection.createIndex(
          { expires: 1 },
          {
            background: true,
            expireAfterSeconds: 0,
          }
        )
```

## Command 3 of 4

command:
```
git -C {repo:connect-mongo} grep -n -e 'collectionP' {pin:connect-mongo} -- src/lib/MongoStore.ts
```
expect: one declaration (163) and one assignment (238); every other line only reads or awaits it (384, 444, 499, 530, 558, 577, 588); no reassignment
classification: ran
exit code: 0
output (9 lines):
```
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:163:  collectionP: Promise<Collection<InternalSessionType<T>>>
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:238:    this.collectionP = _clientP.then(async (con) => {
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:384:        const collection = await this.collectionP
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:444:        const collection = await this.collectionP
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:499:        const collection = await this.collectionP
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:530:        const collection = await this.collectionP
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:558:    this.collectionP
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:577:    this.collectionP
182cfb09ad8a758183f1e2f4ef9867bac4651900:src/lib/MongoStore.ts:588:    this.collectionP
```

## Command 4 of 4

command:
```
git -C {repo:connect-mongo} grep -n -i -e 'retry' -e 'reconnect' -e 'unhandled' -e 'disconnect' {pin:connect-mongo} -- src/lib/MongoStore.ts src/index.ts
```
expect: empty output: no retry, no reconnect and no connect/disconnect events in the library source
classification: ran
exit code: 1
output (0 lines):
```

```
