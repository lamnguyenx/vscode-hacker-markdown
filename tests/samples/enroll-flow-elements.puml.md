## 1. New Enrollment

### 1.1 Start (empty form)

```puml
@startsalt
{+
  ====<b>Speaker Name
  "                      "
  ====<b>Samples
  [<&plus> Enroll New Sample]
  ---
  [ Cancel ] | [ Save ]
}
@endsalt
```

### 1.2 Click "Enroll New Sample"

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | [<&microphone> Record] | [<&paperclip> Attach File] }
  ---
  [<color:gray><&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [ Save ]
}
@endsalt
```

### 1.3 Click "Record"

#### 1.3.1 Recording in progress

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | ▁▂▃▂▁▂▃▅▄▂▁▂▃▅▆▇ 15.6s | [<color:red><&stop>Recording...] }
  ---
  [<color:gray><&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [ Save ]
}
@endsalt
```

> **Note:** "Enroll New Sample" is disabled while recording is in progress. Only one sample row can record at a time.

#### 1.3.2 Recording error

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | <color:red>Microphone access denied | [<&microphone> Record] | [<&paperclip> Attach File] }
  ---
  [<&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [ Save ]
}
@endsalt
```


### 1.4 Click "Attach File"

#### 1.4.1 File Attached

This is kinda no-op since the actual upload only starts when the user click

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | [<&paperclip> sample-01.wav] | █████████░░░░░░░ 60% }
  ---
  [<color:gray><&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [ Save ]
}
@endsalt
```

#### 1.4.3 Uploading is Done

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | ▁▂▃▂▁▂▃ | [<&media-play> Play] | [<&trash> Delete] }
  ---
  [<&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [<color:blue> Enroll ]
}
@endsalt
```

> **Note:** On success the row transitions to the done state (waveform thumbnail, [Play], [Delete]) — identical to the done state after recording.

### 1.5 Done

#### 1.5.1 Single Done

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | ▁▂▃▂▁▂▃ | [<color:blue><&media-stop> Stop] | [<&trash> Delete] }
  ---
  [<&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [<color:blue> Enroll ]
}
@endsalt
```

> **Note:** Playback is exclusive — starting play on a second utterance automatically stops the first. Clicking Play while playing toggles to Stop.

#### 1.5.2 Multiple Done

```puml
@startsalt
!definelong sampleItem(x)
{<utterance-id-x> | ▁▂▃▂▁▂▃ | [<&media-play> Play] | [<&trash> Delete] }
---
!enddefinelong

{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  sampleItem(00)
  sampleItem(01)
  sampleItem(02)
  ---
  [<&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [<color:blue> Enroll ]
}
@endsalt
```

### 1.6 Saving & Enrollment Extraction (API calls in progress)

After all audio files are recorded / attached

#### Start Extracting

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | enrolling... }
  ---
  { <utterance-id-01> | pending... }
  ---
  { <utterance-id-02> | pending... }
  ---
  [<color:gray><&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [<&reload> Enrolling... ]
}
@endsalt
```


#### Partially Extracted Enrollments

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | <&circle-check> Enrolled }
  ---
  { <utterance-id-01> | pending... }
  ---
  { <utterance-id-02> | pending... }
  ---
  [<color:gray><&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [<&reload> Enrolling... ]
}
@endsalt
```


#### All Enrollments are extraced

```puml
@startsalt
{+
  ====<b>Speaker Name
  "Bob                    "
  ====<b>Samples
  {SI
  ---
  { <utterance-id-00> | <&circle-check> Enrolled }
  ---
  { <utterance-id-01> | <&circle-check> Enrolled  }
  ---
  { <utterance-id-02> | <&circle-check> Enrolled  }
  ---
  [<color:gray><&plus> Enroll New Sample]
  ---
  }
  ---
  [ Cancel ] | [ Ok ]
}
@endsalt
```



## 2. View Enrollment

```puml
@startsalt
!definelong sampleItem(x)
{<utterance-id-x> | ▁▂▃▂▁▂▃ | [<&media-play> Play] | [<&trash> Delete] }
---
!enddefinelong

title Bob
{+

  ====<b>Samples
  {SI
  ---
  sampleItem(00)
  sampleItem(01)
  sampleItem(02)
  ---
  [<&plus> Enroll New Sample]
  ---
  }
  [<&trash> Delete Speaker]
}
@endsalt
```
