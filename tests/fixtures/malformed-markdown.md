# 不正な構文でも編集を続けられるサンプル

```mermaid
flowchart LR
    A --> [
```

$$
\frac{1}{
$$

```geojson
{"type":"FeatureCollection","features": [
```

```topojson
{"type":"Topology","objects":null}
```

```stl
solid incomplete
  facet normal 0 0 1
    outer loop
      vertex invalid 0 0
```

```unknown-language
<script>alert("これはコードとして表示する")</script>
```

最後の段落を編集・保存でき、上のMarkdownを失わないこと。
