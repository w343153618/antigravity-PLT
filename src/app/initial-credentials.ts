// One-time bootstrap credentials: salted scrypt digests only. Existing accounts are never reset.
export const initialCredentials = {
  "user": {
    "salt": "8b71c1d4958dec333981724d7b4431ff",
    "hash": "98bf53b00839943201554fd5144648ea5252b7663791019ebd70d61fe9190a2e579c9aa0dfec3c03210d5d5c8aa9ba4e6ed55c3f6ab7ab033e183da1e2d59861"
  },
  "dianzhang": {
    "salt": "9835faeb259a26c811541d0a3a6e7acb",
    "hash": "4b8ac763034749c4d4f69e1c2efa524f3ce070db32a3683b553f6c737cb06e36bbbcf5c67afd44937dfb1f0fca29fee3a97189bb0b13be6ae32b38c5c949e5f3"
  },
  "admin": {
    "salt": "fc159606386828dc076aa4f637d529ed",
    "hash": "9781122a39c749fec556a8b977c44b0a20e48beb403f920eeff335ab8506b475797622adbd9ed6b24d6f7536b2effd067bd0d5488dbf6822ef4295c2c0484513"
  }
} as const;
